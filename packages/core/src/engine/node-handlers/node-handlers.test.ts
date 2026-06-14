import type { AbortSignalLike } from '@relavium/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { type ExpressionSandbox, createExpressionSandbox } from '../../expression/sandbox.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import type { PlanConfig, PlanVertex } from '../../run-plan.js';
import { createConditionNodeExecutor } from './condition.js';
import { createDispatchingNodeExecutor, createStandardNodeExecutor } from './dispatcher.js';
import { createFanInNodeExecutor } from './fan-in.js';
import { createFanOutNodeExecutor } from './fan-out.js';
import { createInputNodeExecutor, createOutputNodeExecutor } from './io.js';
import { createTransformNodeExecutor } from './transform.js';

const LIVE: AbortSignalLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const ABORTED: AbortSignalLike = { ...LIVE, aborted: true };

/** A signal that reads NOT-aborted on first access (passing the pre-eval guard), then aborted — so the
 *  post-evaluate re-check fires, pinning the cancel-after-evaluate window (Trap 5). */
function abortAfterFirstRead(): AbortSignalLike {
  let reads = 0;
  return {
    get aborted() {
      return reads++ > 0;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

function makeVertex(
  config: PlanConfig,
  graph: { id?: string; dependencies?: readonly string[]; dependents?: readonly string[] } = {},
): PlanVertex {
  return {
    id: graph.id ?? 'node',
    type: config.kind,
    dependencies: graph.dependencies ?? [],
    dependents: graph.dependents ?? [],
    inputSites: [],
    config,
  };
}

function makeCtx(
  vertex: PlanVertex,
  opts: {
    runOutputs?: ReadonlyMap<string, unknown>;
    inputs?: Record<string, unknown>;
    secretInputNames?: ReadonlySet<string>;
    signal?: AbortSignalLike;
  } = {},
): NodeExecContext {
  return {
    vertex,
    runOutputs: opts.runOutputs ?? new Map(),
    inputs: opts.inputs ?? {},
    secretInputNames: opts.secretInputNames ?? new Set(),
    toolPolicy: {},
    emit: () => undefined,
    signal: opts.signal ?? LIVE,
    attemptNumber: 1,
  };
}

let sandbox: ExpressionSandbox;
beforeAll(async () => {
  sandbox = await createExpressionSandbox();
});

function conditionConfig(
  expression: string,
  branches: { when: boolean | string | number; target_node: string }[],
  fallback?: string,
): PlanConfig {
  return {
    kind: 'condition',
    node: {
      id: 'cond',
      type: 'condition',
      expression,
      branches,
      ...(fallback === undefined ? {} : { default: fallback }),
    },
  };
}

describe('condition handler (1.P)', () => {
  const dependents = ['a', 'b'];

  it('routes to the branch whose `when` strictly equals the result', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(
      conditionConfig('1 + 1 === 2', [
        { when: true, target_node: 'a' },
        { when: false, target_node: 'b' },
      ]),
      { dependents },
    );
    const out = await exec.execute(makeCtx(v));
    expect(out).toEqual({ kind: 'branch', selected: ['a'] });
  });

  it('matches strictly (`===`, no coercion): number 2 hits `when: 2`, never `when: "2"`', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(
      conditionConfig('1 + 1', [
        { when: '2', target_node: 'a' },
        { when: 2, target_node: 'b' },
      ]),
      { dependents },
    );
    const out = await exec.execute(makeCtx(v));
    expect(out).toEqual({ kind: 'branch', selected: ['b'] }); // the number branch, not the string
  });

  it('selects the FIRST matching branch and emits exactly one target (Trap 1)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(
      conditionConfig('true', [
        { when: true, target_node: 'a' },
        { when: true, target_node: 'b' },
      ]),
      { dependents },
    );
    const out = await exec.execute(makeCtx(v));
    expect(out).toEqual({ kind: 'branch', selected: ['a'] }); // first only, never both
  });

  it('falls back to `default` when no `when` matches', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(conditionConfig('5', [{ when: 1, target_node: 'a' }], 'b'), {
      dependents,
    });
    const out = await exec.execute(makeCtx(v));
    expect(out).toEqual({ kind: 'branch', selected: ['b'] });
  });

  it('fails `validation` (not an empty `selected`) when no branch matches and no default is set (Trap 1)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(conditionConfig('5', [{ when: 1, target_node: 'a' }]), { dependents });
    const out = await exec.execute(makeCtx(v));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'validation', retryable: false } });
  });

  it('fails `internal` when the selected target is not a downstream dependent (builder-invariant guard)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(conditionConfig('true', [{ when: true, target_node: 'ghost' }]), {
      dependents: ['a'], // 'ghost' is not a dependent
    });
    const out = await exec.execute(makeCtx(v));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'internal', retryable: false } });
  });

  it('maps a sandbox result-type violation (a non-bool/string/number result) to `sandbox_error`', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(conditionConfig('({})', [{ when: true, target_node: 'a' }], 'b'), {
      dependents,
    });
    const out = await exec.execute(makeCtx(v));
    expect(out).toMatchObject({
      kind: 'failed',
      error: { code: 'sandbox_error', retryable: false },
    });
  });

  it('returns `cancelled` (never a retryable failure) when the signal is already aborted (Trap 5)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(conditionConfig('true', [{ when: true, target_node: 'a' }]), {
      dependents,
    });
    const out = await exec.execute(makeCtx(v, { signal: ABORTED }));
    expect(out).toEqual({
      kind: 'failed',
      error: { code: 'cancelled', message: 'the run was cancelled', retryable: false },
    });
  });

  it('returns `cancelled` when the signal aborts AFTER evaluation (post-eval re-check, Trap 5)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(conditionConfig('true', [{ when: true, target_node: 'a' }]), {
      dependents,
    });
    const out = await exec.execute(makeCtx(v, { signal: abortAfterFirstRead() }));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'cancelled' } });
  });

  it('compares an unsettled `run.outputs` reference against undefined (pinned current behavior, Trap 6)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(
      conditionConfig('run.outputs["missing"] === "ready"', [
        { when: true, target_node: 'a' },
        { when: false, target_node: 'b' },
      ]),
      { dependents },
    );
    const out = await exec.execute(makeCtx(v)); // no 'missing' output -> undefined === "ready" -> false
    expect(out).toEqual({ kind: 'branch', selected: ['b'] });
  });

  it('a DEREFERENCE of an unsettled `run.outputs` node throws a loud sandbox_error (Trap 6)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    const v = makeVertex(
      conditionConfig('run.outputs["missing"].score > 5', [{ when: true, target_node: 'a' }], 'b'),
      { dependents },
    );
    const out = await exec.execute(makeCtx(v));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'sandbox_error' } });
  });
});

describe('transform handler (1.P)', () => {
  it('returns the reshaped value as the node output', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: '({ doubled: inputs.n * 2 })' },
    });
    const out = await exec.execute(makeCtx(v, { inputs: { n: 5 } }));
    expect(out).toEqual({ kind: 'completed', output: { doubled: 10 } });
  });

  it('reads run.outputs keys in canonical (sorted) order for resume determinism (Trap 7)', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: 'Object.keys(run.outputs).join(",")' },
    });
    // Inserted z-before-a; the handler must surface a canonical (sorted) key order regardless.
    const runOutputs = new Map<string, unknown>([
      ['z', 1],
      ['a', 2],
    ]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toEqual({ kind: 'completed', output: 'a,z' });
  });

  it('cannot mutate the frozen scope — a write throws sandbox_error and leaves ctx.inputs intact (Trap 4)', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: '(inputs.foo = 1)' },
    });
    const inputs = { n: 1 };
    const out = await exec.execute(makeCtx(v, { inputs }));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'sandbox_error' } });
    expect(inputs).toEqual({ n: 1 }); // unchanged for sibling nodes
  });

  it('maps a non-serializable result (a returned function) to sandbox_error', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: '(() => 1)' },
    });
    const out = await exec.execute(makeCtx(v));
    expect(out).toMatchObject({
      kind: 'failed',
      error: { code: 'sandbox_error', retryable: false },
    });
  });

  it('returns `cancelled` when the signal is already aborted', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: '1' },
    });
    const out = await exec.execute(makeCtx(v, { signal: ABORTED }));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'cancelled' } });
  });

  it('returns `cancelled` when the signal aborts AFTER evaluation (post-eval re-check, Trap 5)', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: '1' },
    });
    const out = await exec.execute(makeCtx(v, { signal: abortAfterFirstRead() }));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'cancelled' } });
  });
});

function fanInConfig(
  mergeStrategy: 'concat' | 'object_merge' | 'first' | 'custom',
  branchNodeIds: readonly string[],
  mergeFn?: string,
): PlanConfig {
  return {
    kind: 'fan_in',
    node: {
      id: 'm',
      type: 'merge',
      merge_strategy: mergeStrategy,
      ...(mergeFn === undefined ? {} : { merge_fn: mergeFn }),
    },
    joinStrategy: mergeStrategy === 'first' ? 'wait_first' : 'wait_all',
    mergeStrategy,
    branchNodeIds,
    ...(mergeFn === undefined ? {} : { mergeFn }),
  };
}

describe('fan_in handler (1.P)', () => {
  it('concat collects branch outputs in branchNodeIds order, NOT arrival/dependencies order (Trap 2)', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('concat', ['c', 'a', 'b']));
    // Inserted in arrival order b,a,c — the result must follow declaration order c,a,b.
    const runOutputs = new Map<string, unknown>([
      ['b', 'B'],
      ['a', 'A'],
      ['c', 'C'],
    ]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toEqual({ kind: 'completed', output: ['C', 'A', 'B'] });
  });

  it('omits a skipped (absent) branch while preserving the relative order of survivors (Trap 2)', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('concat', ['c', 'a', 'b']));
    const runOutputs = new Map<string, unknown>([
      ['c', 'C'],
      ['b', 'B'],
    ]); // 'a' was skipped
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toEqual({ kind: 'completed', output: ['C', 'B'] });
  });

  it('object_merge has later-in-order branches win on key collision, independent of arrival order (Trap 7)', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('object_merge', ['a', 'c']));
    const runOutputs = new Map<string, unknown>([
      ['c', { k: 2, only_c: true }],
      ['a', { k: 1, only_a: true }],
    ]); // arrival c-before-a; branchNodeIds order is [a, c]
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    // Distinct keys survive; the colliding `k` is won by 'c' (later in branchNodeIds order), regardless
    // of arrival order. Full-shape assertion (a plain object with Object.prototype).
    expect(out).toEqual({
      kind: 'completed',
      output: { k: 2, only_a: true, only_c: true },
    });
  });

  it('object_merge uses a null-prototype accumulator so a `__proto__` branch key cannot hijack the result', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('object_merge', ['a']));
    const malicious = JSON.parse('{"__proto__":{"injected":true}}') as Record<string, unknown>;
    const runOutputs = new Map<string, unknown>([['a', malicious]]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    const output = (out as { output: object }).output;
    expect(Object.getPrototypeOf(output)).toBeNull(); // not the attacker object
    expect((output as Record<string, unknown>)['injected']).toBeUndefined();
  });

  it('object_merge fails `validation` when a branch output is not a JSON object', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('object_merge', ['a', 'b']));
    const runOutputs = new Map<string, unknown>([
      ['a', { k: 1 }],
      ['b', 'not-an-object'],
    ]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'validation' } });
  });

  it('first takes the first surviving branch by declaration order (executor-only wait_first)', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('first', ['a', 'b']));
    const runOutputs = new Map<string, unknown>([
      ['b', 'B'],
      ['a', 'A'],
    ]); // 'a' is first in order
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toEqual({ kind: 'completed', output: 'A' });
  });

  it('custom merge_fn receives `branches` in branchNodeIds order plus run.outputs', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(
      fanInConfig('custom', ['a', 'b'], '({ first: branches[0], second: branches[1] })'),
    );
    const runOutputs = new Map<string, unknown>([
      ['b', 20],
      ['a', 10],
    ]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toEqual({ kind: 'completed', output: { first: 10, second: 20 } });
  });

  it('a custom merge_fn that throws at runtime maps to a fatal sandbox_error', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('custom', ['a'], 'branches[0].nope.deep'));
    const runOutputs = new Map<string, unknown>([['a', 1]]); // 1.nope is undefined -> .deep throws
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toMatchObject({
      kind: 'failed',
      error: { code: 'sandbox_error', retryable: false },
    });
  });

  it('a custom merge_fn returning a non-serializable value maps to sandbox_error', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('custom', ['a'], '(() => 1)'));
    const runOutputs = new Map<string, unknown>([['a', 1]]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toMatchObject({
      kind: 'failed',
      error: { code: 'sandbox_error', retryable: false },
    });
  });

  it('handles an empty branch set (every branch skipped) per strategy', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const empty = new Map<string, unknown>(); // all branchNodeIds absent
    const concat = await exec.execute(
      makeCtx(makeVertex(fanInConfig('concat', ['a', 'b'])), { runOutputs: empty }),
    );
    expect(concat).toEqual({ kind: 'completed', output: [] });
    const first = await exec.execute(
      makeCtx(makeVertex(fanInConfig('first', ['a', 'b'])), { runOutputs: empty }),
    );
    expect(first).toEqual({ kind: 'completed', output: null });
    const merged = await exec.execute(
      makeCtx(makeVertex(fanInConfig('object_merge', ['a', 'b'])), { runOutputs: empty }),
    );
    expect(merged).toMatchObject({ kind: 'completed' });
    expect(Object.keys((merged as { output: object }).output)).toEqual([]);
  });

  it('returns `cancelled` when the signal is already aborted', async () => {
    const exec = createFanInNodeExecutor({ sandbox });
    const v = makeVertex(fanInConfig('concat', ['a']));
    const out = await exec.execute(makeCtx(v, { signal: ABORTED }));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'cancelled' } });
  });
});

describe('fan_out / input / output handlers (1.P)', () => {
  it('fan_out completes with a null output (the spread is edge-driven)', async () => {
    const exec = createFanOutNodeExecutor();
    const v = makeVertex({
      kind: 'fan_out',
      node: { id: 'p', type: 'parallel', parallel_of: ['a', 'b'] },
      branchNodeIds: ['a', 'b'],
    });
    const out = await exec.execute(makeCtx(v));
    expect(out).toEqual({ kind: 'completed', output: null });
  });

  it('input emits a snapshot of the resolved inputs (value-equal, not aliased)', async () => {
    const exec = createInputNodeExecutor();
    const v = makeVertex({ kind: 'input', node: { id: 'in', type: 'input' } });
    const inputs = { a: 1, b: 'x' };
    const out = await exec.execute(makeCtx(v, { inputs }));
    expect(out).toEqual({ kind: 'completed', output: { a: 1, b: 'x' } });
    expect((out as { output: object }).output).not.toBe(inputs); // a copy, not the engine's record
  });

  it('output captures its single feeder verbatim', async () => {
    const exec = createOutputNodeExecutor();
    const v = makeVertex(
      { kind: 'output', node: { id: 'out', type: 'output' } },
      { dependencies: ['report'] },
    );
    const runOutputs = new Map<string, unknown>([['report', { md: '# done' }]]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toEqual({ kind: 'completed', output: { md: '# done' } });
  });

  it('output captures a deterministic per-feeder record when fed by several nodes', async () => {
    const exec = createOutputNodeExecutor();
    const v = makeVertex(
      { kind: 'output', node: { id: 'out', type: 'output' } },
      { dependencies: ['b', 'a'] },
    );
    const runOutputs = new Map<string, unknown>([
      ['a', 1],
      ['b', 2],
    ]);
    const out = await exec.execute(makeCtx(v, { runOutputs }));
    expect(out).toEqual({ kind: 'completed', output: { a: 1, b: 2 } });
    // Deterministic key order: feeders declared ['b','a'] are captured sorted — drop io.ts's .sort() and this fails.
    expect(Object.keys((out as { output: Record<string, unknown> }).output)).toEqual(['a', 'b']);
  });

  it('output is null when it has no settled feeder', async () => {
    const exec = createOutputNodeExecutor();
    const v = makeVertex(
      { kind: 'output', node: { id: 'out', type: 'output' } },
      { dependencies: ['gone'] },
    );
    const out = await exec.execute(makeCtx(v)); // 'gone' absent
    expect(out).toEqual({ kind: 'completed', output: null });
  });
});

describe('secret-input masking (1.P security — BLOCKER fix)', () => {
  const secretInputNames = new Set(['api_key']);

  it('the input handler masks a secret-typed input in its emitted output (never the raw value)', async () => {
    const exec = createInputNodeExecutor();
    const v = makeVertex({ kind: 'input', node: { id: 'in', type: 'input' } });
    const out = await exec.execute(
      makeCtx(v, { inputs: { api_key: 'sk-RAW', name: 'ok' }, secretInputNames }),
    );
    expect(out).toEqual({
      kind: 'completed',
      output: { api_key: { secret: true, ref: 'inputs.api_key' }, name: 'ok' },
    });
    // The raw secret must never ride node:completed.output / run:completed.outputs.
    expect(JSON.stringify(out)).not.toContain('sk-RAW');
  });

  it('a transform sees the masked marker, not the raw secret — it cannot launder it into run.outputs', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: 'inputs.api_key' },
    });
    const out = await exec.execute(makeCtx(v, { inputs: { api_key: 'sk-RAW' }, secretInputNames }));
    expect(out).toEqual({ kind: 'completed', output: { secret: true, ref: 'inputs.api_key' } });
    expect(JSON.stringify(out)).not.toContain('sk-RAW');
  });

  it('a condition cannot branch on the raw secret value (it sees only the masked marker)', async () => {
    const exec = createConditionNodeExecutor({ sandbox });
    // `=== "sk-RAW"` would be true on the raw value; on the masked marker object it is false.
    const v = makeVertex(
      conditionConfig('inputs.api_key === "sk-RAW"', [
        { when: true, target_node: 'leaked' },
        { when: false, target_node: 'safe' },
      ]),
      { dependents: ['leaked', 'safe'] },
    );
    const out = await exec.execute(makeCtx(v, { inputs: { api_key: 'sk-RAW' }, secretInputNames }));
    expect(out).toEqual({ kind: 'branch', selected: ['safe'] });
  });
});

describe('dispatching executor (1.P)', () => {
  it('routes a vertex to the handler registered for its type', async () => {
    const stub: NodeExecutor = {
      execute: () => Promise.resolve<NodeOutcome>({ kind: 'completed', output: 'INPUT' }),
    };
    const exec = createDispatchingNodeExecutor({ input: stub });
    const v = makeVertex({ kind: 'input', node: { id: 'in', type: 'input' } });
    const out = await exec.execute(makeCtx(v));
    expect(out).toEqual({ kind: 'completed', output: 'INPUT' });
  });

  it('fails loud (typed internal, never silent) for an unregistered node type', async () => {
    const exec = createDispatchingNodeExecutor({});
    const v = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: '1' },
    });
    const out = await exec.execute(makeCtx(v));
    expect(out).toMatchObject({ kind: 'failed', error: { code: 'internal', retryable: false } });
  });

  it('createStandardNodeExecutor wires the six non-agent handlers; an agent vertex stays unhandled without agent deps', async () => {
    const exec = createStandardNodeExecutor({ sandbox });
    const transformV = makeVertex({
      kind: 'transform',
      node: { id: 't', type: 'transform', transform: '7' },
    });
    expect(await exec.execute(makeCtx(transformV))).toEqual({ kind: 'completed', output: 7 });
    // No agent deps supplied -> the agent arm is absent -> loud internal failure, never a silent skip.
    const agentV = makeVertex({ kind: 'agent', node: { id: 'a', type: 'agent', agent_ref: 'x' } });
    expect(await exec.execute(makeCtx(agentV))).toMatchObject({
      kind: 'failed',
      error: { code: 'internal' },
    });
  });

  it('one shared sandbox serves concurrent expression nodes with no cross-node bleed (Trap 3)', async () => {
    const exec = createStandardNodeExecutor({ sandbox });
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => {
        const v = makeVertex({
          kind: 'transform',
          node: { id: `t${n}`, type: 'transform', transform: 'inputs.n * 10' },
        });
        return exec.execute(makeCtx(v, { inputs: { n } }));
      }),
    );
    expect(outcomes).toEqual([10, 20, 30, 40, 50].map((output) => ({ kind: 'completed', output })));
  });

  it('a fresh VM per evaluation — VM-global state never persists across two evals on one sandbox (Trap 3)', async () => {
    const exec = createTransformNodeExecutor({ sandbox });
    // A reused runtime/context would let the second eval observe 2; a fresh context per call yields 1, 1.
    const v = makeVertex({
      kind: 'transform',
      node: {
        id: 't',
        type: 'transform',
        transform: '(globalThis.__leak = (globalThis.__leak || 0) + 1, globalThis.__leak)',
      },
    });
    expect(await exec.execute(makeCtx(v))).toEqual({ kind: 'completed', output: 1 });
    expect(await exec.execute(makeCtx(v))).toEqual({ kind: 'completed', output: 1 });
  });

  it('createStandardNodeExecutor routes every engine node type to its handler', async () => {
    const exec = createStandardNodeExecutor({ sandbox });
    const fanOut = await exec.execute(
      makeCtx(
        makeVertex({
          kind: 'fan_out',
          node: { id: 'p', type: 'parallel', parallel_of: ['x'] },
          branchNodeIds: ['x'],
        }),
      ),
    );
    expect(fanOut).toEqual({ kind: 'completed', output: null });
    const input = await exec.execute(
      makeCtx(makeVertex({ kind: 'input', node: { id: 'i', type: 'input' } }), {
        inputs: { a: 1 },
      }),
    );
    expect(input).toEqual({ kind: 'completed', output: { a: 1 } });
    const output = await exec.execute(
      makeCtx(
        makeVertex({ kind: 'output', node: { id: 'o', type: 'output' } }, { dependencies: ['u'] }),
        {
          runOutputs: new Map([['u', 'cap']]),
        },
      ),
    );
    expect(output).toEqual({ kind: 'completed', output: 'cap' });
    const cond = await exec.execute(
      makeCtx(
        makeVertex(conditionConfig('true', [{ when: true, target_node: 'd' }]), {
          dependents: ['d'],
        }),
      ),
    );
    expect(cond).toEqual({ kind: 'branch', selected: ['d'] });
    const fanIn = await exec.execute(
      makeCtx(makeVertex(fanInConfig('concat', ['a'])), { runOutputs: new Map([['a', 1]]) }),
    );
    expect(fanIn).toEqual({ kind: 'completed', output: [1] });
  });
});
