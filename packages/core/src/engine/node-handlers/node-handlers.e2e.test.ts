import type { RunEvent } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { createExpressionSandbox, type ExpressionSandbox } from '../../expression/sandbox.js';
import { buildRunPlan } from '../../dag.js';
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
      // Only the condFirst=true arm break-verifies the filter; condFirst=false was already correct
      // before it and is kept as a non-regression check that the fix did not break the working order.
      // Before the fix this was `null` for condFirst=true and `"WORK"` for condFirst=false: the
      // condition landed in the completed-output map with `undefined`, satisfied the fan-in's
      // `runOutputs.has(id)` guard, and became branch #0 whenever it was authored first.
      expect(completed?.type === 'run:completed' && completed.outputs).toEqual({ out: 'WORK' });
    });
  }

  it('the condition stays a DEPENDENCY of the merge — dropped from the value list, not from the graph', () => {
    // Asserted on the PLAN, not on event order. An earlier version of this case compared the two
    // `node:completed` indices, which proves nothing here: `cond` and `work` both settle synchronously,
    // so `join` lands after both whether or not `cond` is in `dependencies`. It passed for a reason
    // unrelated to its own comment — the same hollowness this wave has now hit three times. The claim is
    // structural, so assert the structure.
    const plan = buildRunPlan(parseWorkflow(CONTROL_EDGE(true)));
    const join = plan.vertices.get('join');
    expect(join?.dependencies).toContain('cond'); // still gates the join
    const cfg = join?.config;
    expect(cfg?.kind === 'fan_in' && cfg.branchNodeIds).toEqual(['work']); // but carries no value
  });

  it('a `parallel` naming the merge in `parallel_of` is a control edge too', async () => {
    // The path my own ADR amendment declared impossible. An explicit edge from a `parallel` to a node
    // outside its `parallel_of` IS refused at parse — but `parallel_of: [work, join]` names the merge
    // INSIDE `parallel_of`, so the builder materializes that fan-out edge itself and it never meets the
    // validator. A `parallel` completes with a control `null`, so before the fix `first` returned `null`
    // and discarded the real branch, exit 0.
    const WF = `schema_version: '1.0'
workflow:
  id: parallel-phantom
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [join, work] }
    - { id: work, type: transform, transform: '"WORK"' }
    - { id: join, type: merge, merge_strategy: first }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: work, to: join }
    - { from: join, to: out }
`;
    const plan = buildRunPlan(parseWorkflow(WF));
    const cfg = plan.vertices.get('join')?.config;
    expect(cfg?.kind === 'fan_in' && cfg.branchNodeIds).toEqual(['work']);
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: createStandardNodeExecutor({ sandbox }),
    });
    const events = await drain(engine.start({ workflow: parseWorkflow(WF) }));
    const completed = events.find((e) => e.type === 'run:completed');
    expect(completed?.type === 'run:completed' && completed.outputs).toEqual({ out: 'WORK' });
  });

  it('filtering does not reorder the REAL branches of a paired parallel', () => {
    // The regression the first version of this fix introduced. `parallel_of: [cond, c, b]` declares the
    // survivors in the order [c, b]; filtering the condition out BEFORE the pairing search made
    // `every(m => predSet.has(m))` fail, the pairing was lost, and the survivors fell back to AUTHORED
    // order — [b, c]. Two real branches silently swapped by the fix, not by the bug.
    const WF = `schema_version: '1.0'
workflow:
  id: reorder
  inputs:
    - { name: t, type: boolean }
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [cond, c, b] }
    - id: cond
      type: condition
      expression: 'inputs.t'
      branches: [{ when: true, target_node: join }, { when: false, target_node: join }]
    - { id: b, type: transform, transform: '"B"' }
    - { id: c, type: transform, transform: '"C"' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: b, to: join }
    - { from: c, to: join }
    - { from: join, to: out }
`;
    const cfg = buildRunPlan(parseWorkflow(WF)).vertices.get('join')?.config;
    // `parallel_of` order for the survivors — NOT the authored node order [b, c].
    expect(cfg?.kind === 'fan_in' && cfg.branchNodeIds).toEqual(['c', 'b']);
  });

  it('a value-less parallel does not STEAL the pairing from the one that supplies the branches', () => {
    // The mirror of the reorder regression, and the second version of this fix reintroduced it through
    // the opposite door. Two parallels feed one merge: `gate` fans out guard conditions (supplying no
    // value), `work-fan` fans out the real work as `parallel_of: [c, b]`. Searching the UNFILTERED
    // predecessors let `gate` match first, which pushed every real branch into `extras` — authored order
    // — so `concat` returned ["B","C"] where the author declared [c, b]. Pairing is now ranked by how
    // much VALUE a candidate covers, so a candidate covering nothing can never win.
    const WF = `schema_version: '1.0'
workflow:
  id: two-parallels
  inputs:
    - { name: t, type: boolean }
  nodes:
    - { id: start, type: input }
    - { id: gate, type: parallel, parallel_of: [g1, g2] }
    - id: g1
      type: condition
      expression: 'inputs.t'
      branches: [{ when: true, target_node: join }, { when: false, target_node: join }]
    - id: g2
      type: condition
      expression: 'inputs.t'
      branches: [{ when: true, target_node: join }, { when: false, target_node: join }]
    - { id: work-fan, type: parallel, parallel_of: [c, b] }
    - { id: b, type: transform, transform: '"B"' }
    - { id: c, type: transform, transform: '"C"' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: gate }
    - { from: start, to: work-fan }
    - { from: b, to: join }
    - { from: c, to: join }
    - { from: join, to: out }
`;
    const cfg = buildRunPlan(parseWorkflow(WF)).vertices.get('join')?.config;
    expect(cfg?.kind === 'fan_in' && cfg.branchNodeIds).toEqual(['c', 'b']);
  });

  it('a `parallel_of` naming the merge itself still pairs — the merge is not a branch of itself', () => {
    // `parallel_of: [c, b, join]` is the shape the earlier correction newly established as reachable.
    // The membership test `every(m => preds.has(m))` can never hold for it — a merge is not its own
    // predecessor — so the pairing was lost and two real branches fell to authored order. The merge's
    // own id is now exempt from the test and dropped from the ordered list explicitly, because
    // `producesValue('merge')` is true and the value filter would otherwise keep it.
    const WF = `schema_version: '1.0'
workflow:
  id: self-named
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [c, b, join] }
    - { id: b, type: transform, transform: '"B"' }
    - { id: c, type: transform, transform: '"C"' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: b, to: join }
    - { from: c, to: join }
    - { from: join, to: out }
`;
    const cfg = buildRunPlan(parseWorkflow(WF)).vertices.get('join')?.config;
    expect(cfg?.kind === 'fan_in' && cfg.branchNodeIds).toEqual(['c', 'b']);
  });

  it('an exact-match parallel outranks a SUBSET parallel authored before it', () => {
    // Pre-existing, caused by neither earlier version, and repaired for free by ranking on coverage:
    // `narrow: [b]` is authored first and its members are all predecessors, so under a first-match
    // search it won and the exact match's declared order `[c, b]` was discarded.
    const WF = `schema_version: '1.0'
workflow:
  id: subset
  nodes:
    - { id: start, type: input }
    - { id: narrow, type: parallel, parallel_of: [b] }
    - { id: wide, type: parallel, parallel_of: [c, b] }
    - { id: b, type: transform, transform: '"B"' }
    - { id: c, type: transform, transform: '"C"' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: out, type: output }
  edges:
    - { from: start, to: narrow }
    - { from: start, to: wide }
    - { from: b, to: join }
    - { from: c, to: join }
    - { from: join, to: out }
`;
    const cfg = buildRunPlan(parseWorkflow(WF)).vertices.get('join')?.config;
    expect(cfg?.kind === 'fan_in' && cfg.branchNodeIds).toEqual(['c', 'b']);
  });

  it('a `parallel` naming an OUTPUT in `parallel_of` is filtered from its feeders too', async () => {
    // The `producesValue` rule has two consumers; only the merge side was pinned. This is the output
    // twin — asserted on the plan AND end-to-end, because the visible symptom is a shape change
    // (`{ work: 'WORK' }` instead of `'WORK'`) that `JSON.stringify` makes look deliberate.
    const WF = `schema_version: '1.0'
workflow:
  id: parallel-out
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [out, work] }
    - { id: work, type: transform, transform: '"WORK"' }
    - { id: out, type: output }
  edges:
    - { from: start, to: fan }
    - { from: work, to: out }
`;
    const cfg = buildRunPlan(parseWorkflow(WF)).vertices.get('out')?.config;
    expect(cfg?.kind === 'output' && cfg.feederNodeIds).toEqual(['work']);
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: createStandardNodeExecutor({ sandbox }),
    });
    const events = await drain(engine.start({ workflow: parseWorkflow(WF) }));
    const completed = events.find((e) => e.type === 'run:completed');
    expect(completed?.type === 'run:completed' && completed.outputs).toEqual({ out: 'WORK' });
  });

  it('an `output` fed by a condition captures its one real feeder VERBATIM, not a wrapper', async () => {
    // The same phantom, one handler over, and entirely untouched by the merge fix: `runOutput` derived
    // its feeders from `dependencies` filtered by `runOutputs.has(id)`, which a completed condition
    // satisfies with the value `undefined`. The result was `{ work: 'WORK' }` — a keyed wrapper with a
    // phantom `cond: undefined` beside it that `JSON.stringify` dropped, so it read as intentional.
    const WF = `schema_version: '1.0'
workflow:
  id: cond-out
  inputs:
    - { name: t, type: boolean }
  nodes:
    - { id: start, type: input }
    - id: cond
      type: condition
      expression: 'inputs.t'
      branches: [{ when: true, target_node: out }, { when: false, target_node: other }]
    - { id: work, type: transform, transform: '"WORK"' }
    - { id: other, type: transform, transform: '"OTHER"' }
    - { id: out, type: output }
  edges:
    - { from: start, to: cond }
    - { from: start, to: work }
    - { from: work, to: out }
`;
    const engine = new WorkflowEngine({
      host: createInMemoryHost(),
      executor: createStandardNodeExecutor({ sandbox }),
    });
    const events = await drain(engine.start({ workflow: parseWorkflow(WF), inputs: { t: true } }));
    const completed = events.find((e) => e.type === 'run:completed');
    expect(completed?.type === 'run:completed' && completed.outputs).toEqual({ out: 'WORK' });
  });
});
