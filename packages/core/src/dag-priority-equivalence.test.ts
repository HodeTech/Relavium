import type { Agent, WorkflowNode } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { buildRunPlan } from './dag.js';
import { WorkflowGraphError, WorkflowSecretLeakError, WorkflowValidationError } from './errors.js';
import type { ReferenceSite } from './interpolation/collect.js';
import { parseWorkflow } from './parser.js';
import type { PlanConfig, PlanVertex, RunPlan } from './run-plan.js';

type Pair = readonly [string, string];
interface GraphCase {
  readonly seed: number;
  readonly ids: readonly string[];
  readonly pairs: readonly Pair[];
}
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture index missing');
  return value;
}

/** Independent full-sort Kahn oracle; edges come only from fixture inputs. */
function fullSortReference(graph: GraphCase) {
  const index = new Map(graph.ids.map((id, position) => [id, position]));
  const before = new Map(graph.ids.map((id) => [id, new Set<string>()]));
  const after = new Map(graph.ids.map((id) => [id, new Set<string>()]));
  for (const [from, to] of graph.pairs) {
    requireValue(before.get(to)).add(from);
    requireValue(after.get(from)).add(to);
  }
  const degrees = new Map(graph.ids.map((id) => [id, requireValue(before.get(id)).size]));
  const byAuthored = (a: string, b: string): number =>
    requireValue(index.get(a)) - requireValue(index.get(b));
  const ready = graph.ids.filter((id) => degrees.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(byAuthored);
    const id = requireValue(ready.shift());
    order.push(id);
    for (const child of requireValue(after.get(id))) {
      const degree = requireValue(degrees.get(child)) - 1;
      degrees.set(child, degree);
      if (degree === 0) ready.push(child);
    }
  }
  const ancestors = (id: string): string[] => {
    const found = new Set<string>();
    const pending = [...requireValue(before.get(id))];
    while (pending.length > 0) {
      const parent = requireValue(pending.pop());
      if (found.has(parent)) continue;
      found.add(parent);
      pending.push(...requireValue(before.get(parent)));
    }
    return [...found].sort(ordinal);
  };
  return {
    order,
    unprocessed: graph.ids.filter((id) => !order.includes(id)),
    before,
    after,
    ancestors,
    byAuthored,
  };
}
function expectedPlan(
  graph: GraphCase,
  configs: readonly PlanConfig[],
  inputSites: ReadonlyMap<string, readonly ReferenceSite[]> = new Map(),
  extra: Pick<RunPlan, 'maxParallel' | 'timeoutMs' | 'budget'> = {},
): RunPlan {
  const ref = fullSortReference(graph);
  const vertices = new Map<string, PlanVertex>();
  for (const config of configs) {
    const id = config.node.id;
    vertices.set(id, {
      id,
      type: config.kind,
      dependencies: [...requireValue(ref.before.get(id))].sort(ref.byAuthored),
      dependents: [...requireValue(ref.after.get(id))].sort(ref.byAuthored),
      ancestors: ref.ancestors(id),
      inputSites: inputSites.get(id) ?? [],
      config,
    });
  }
  return { workflowId: 'priority', order: ref.order, vertices, ...extra };
}
function actualPlan(
  nodes: readonly WorkflowNode[],
  pairs: readonly Pair[],
  extra: Record<string, unknown> = {},
  agents?: readonly Agent[],
): RunPlan {
  return buildRunPlan(
    parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'priority',
          nodes,
          edges: pairs.map(([from, to]) => ({ from, to })),
          ...extra,
          ...(agents === undefined ? {} : { agents }),
        },
      }),
    ),
  );
}
function inputNodes(ids: readonly string[]): Extract<WorkflowNode, { type: 'input' }>[] {
  return ids.map((id) => ({ id, type: 'input' }));
}
function generated(seed: number, count: number): GraphCase {
  let state = seed + 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const shuffle = <T>(values: readonly T[]): T[] => {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = next() % (i + 1);
      const current = requireValue(out[i]);
      out[i] = requireValue(out[j]);
      out[j] = current;
    }
    return out;
  };
  const ranking = Array.from({ length: count }, (_, index) => `node-${count - index}`);
  const pairs: Pair[] = [];
  for (let i = 0; i < count; i += 1)
    for (let j = i + 1; j < count; j += 1)
      if (next() % 5 === 0) pairs.push([requireValue(ranking[i]), requireValue(ranking[j])]);
  return { seed, ids: shuffle(ranking), pairs: shuffle(pairs) };
}
function outputSite(id: string, field: string, producer: string): ReferenceSite {
  const raw = `{{run.outputs["${producer}"]}}`;
  const reference = {
    kind: 'node',
    identifier: producer,
    path: '',
    filters: [],
    raw,
  } satisfies ReferenceSite['references'][number];
  return {
    location: `node \`${id}\`.${field}`,
    category: 'node-text',
    segments: [{ kind: 'reference', reference }],
    references: [reference],
  };
}

describe('authored-minimum DAG priority equivalence (#275)', () => {
  it.each([
    ['a', 'b', 'c'],
    ['z-last', 'a-first', 'm-middle'],
  ])('newly unlocked lower authored index precedes old ready vertex: %j', (...ids) => {
    const graph: GraphCase = {
      seed: 0,
      ids,
      pairs: [[requireValue(ids[0]), requireValue(ids[1])]],
    };
    expect(
      actualPlan(inputNodes(ids), graph.pairs),
      'complete plan uses minimum authored ready index',
    ).toEqual(
      expectedPlan(
        graph,
        inputNodes(ids).map((node) => ({ kind: 'input', node })),
      ),
    );
    expect(fullSortReference(graph).order).toEqual(ids);
  });

  it.each(Array.from({ length: 72 }, (_, seed) => generated(seed, 1 + (seed % 13))))(
    'generated admitted DAG plans equal independent full-sort plans: seed $seed',
    (graph) => {
      const nodes = inputNodes(graph.ids);
      const extra = {
        maxParallel: 7,
        timeoutMs: 60000,
        budget: { max_cost_microcents: 200000000, on_exceed: 'fail' },
      } satisfies Pick<RunPlan, 'maxParallel' | 'timeoutMs' | 'budget'>;
      expect(fullSortReference(graph).unprocessed).toEqual([]);
      expect(
        actualPlan(nodes, graph.pairs, {
          max_parallel: extra.maxParallel,
          timeout_ms: extra.timeoutMs,
          budget: extra.budget,
        }),
        `seed=${graph.seed}; authored=${graph.ids.join(',')}`,
      ).toEqual(
        expectedPlan(
          graph,
          nodes.map((node) => ({ kind: 'input', node })),
          new Map(),
          extra,
        ),
      );
    },
  );

  it.each([
    {
      name: 'chain',
      ids: ['end', 'middle', 'start'],
      pairs: [
        ['start', 'middle'],
        ['middle', 'end'],
      ],
      order: ['start', 'middle', 'end'],
    },
    {
      name: 'diamond join with unrelated ready root',
      ids: ['join', 'right', 'left', 'root', 'free'],
      pairs: [
        ['root', 'left'],
        ['root', 'right'],
        ['left', 'join'],
        ['right', 'join'],
      ],
      order: ['root', 'right', 'left', 'join', 'free'],
    },
    {
      name: 'disconnected roots',
      ids: ['later', 'free', 'root', 'end'],
      pairs: [
        ['root', 'later'],
        ['later', 'end'],
      ],
      order: ['free', 'root', 'later', 'end'],
    },
  ] satisfies readonly {
    name: string;
    ids: readonly string[];
    pairs: readonly Pair[];
    order: readonly string[];
  }[])('named topology pins oracle and actual complete plan: $name', ({ ids, pairs, order }) => {
    const graph: GraphCase = { seed: 104, ids, pairs };
    const nodes = inputNodes(ids);
    expect(
      fullSortReference(graph).order,
      'independent oracle matches declared topology order',
    ).toEqual(order);
    const actual = actualPlan(nodes, pairs);
    expect(actual.order, 'actual priority matches declared topology order').toEqual(order);
    expect(actual).toEqual(
      expectedPlan(
        graph,
        nodes.map((node) => ({ kind: 'input', node })),
      ),
    );
  });

  it('literal system append still refuses declared secret references at actual parser admission', () => {
    expect(
      () =>
        parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'secret-append',
              inputs: [{ name: 'token', type: 'secret' }],
              agents: [
                {
                  id: 'writer',
                  provider: 'anthropic',
                  model: 'model',
                  system_prompt: 'Clean authored system.',
                },
              ],
              nodes: [
                {
                  id: 'writer-node',
                  type: 'agent',
                  agent_ref: 'writer',
                  system_prompt_append: '{{inputs.token}}',
                },
              ],
              edges: [],
            },
          }),
        ),
      'literal assembly does not remove parser secret-taint admission',
    ).toThrow(WorkflowSecretLeakError);
  });

  it('moderate wide frontier and duplicate structural edges preserve the whole plan', () => {
    const ids = Array.from({ length: 48 }, (_, index) => `wide-${48 - index}`);
    const pairs: Pair[] = ids.slice(1).map((id) => [requireValue(ids[0]), id]);
    const graph = { seed: 100, ids, pairs: [...pairs, ...pairs] };
    const nodes = inputNodes(ids);
    expect(actualPlan(nodes, graph.pairs)).toEqual(
      expectedPlan(
        graph,
        nodes.map((node) => ({ kind: 'input', node })),
      ),
    );
  });

  it('derived fanout and merge mappings preserve exact complete plan', () => {
    const nodes: WorkflowNode[] = [
      { id: 'split', type: 'parallel', parallel_of: ['z-branch', 'a-branch'] },
      { id: 'join', type: 'merge', merge_strategy: 'first' },
      { id: 'a-branch', type: 'input' },
      { id: 'z-branch', type: 'input' },
      { id: 'done', type: 'output' },
    ];
    const explicit: Pair[] = [
      ['a-branch', 'join'],
      ['z-branch', 'join'],
      ['join', 'done'],
    ];
    const graph = {
      seed: 101,
      ids: nodes.map((node) => node.id),
      pairs: [...explicit, ['split', 'z-branch'], ['split', 'a-branch']] satisfies Pair[],
    };
    const configs: PlanConfig[] = [
      {
        kind: 'fan_out',
        node: { id: 'split', type: 'parallel', parallel_of: ['z-branch', 'a-branch'] },
        branchNodeIds: ['z-branch', 'a-branch'],
      },
      {
        kind: 'fan_in',
        node: { id: 'join', type: 'merge', merge_strategy: 'first' },
        requestedJoinStrategy: 'wait_first',
        mergeStrategy: 'first',
        branchNodeIds: ['z-branch', 'a-branch'],
      },
      { kind: 'input', node: { id: 'a-branch', type: 'input' } },
      { kind: 'input', node: { id: 'z-branch', type: 'input' } },
      { kind: 'output', node: { id: 'done', type: 'output' }, feederNodeIds: ['join'] },
    ];
    expect(
      actualPlan(nodes, explicit),
      'derived fanout plan matches independent mapping and priority',
    ).toEqual(expectedPlan(graph, configs));
  });

  it('agent system, literal append, prompt and gate references retain dependency and full-plan mapping', () => {
    const agent: Agent = {
      id: 'writer',
      provider: 'anthropic',
      model: 'model',
      system_prompt: '{{run.outputs["system-up"]}}',
    };
    const node: Extract<WorkflowNode, { type: 'agent' }> = {
      id: 'writer-node',
      type: 'agent',
      agent_ref: 'writer',
      prompt_template: '{{run.outputs["prompt-up"]}}',
      system_prompt_append: '{{run.outputs["append-up"]}}',
    };
    const gate: Extract<WorkflowNode, { type: 'human_gate' }> = {
      id: 'gate',
      type: 'human_gate',
      gate_type: 'approval',
      assignee: '{{run.outputs["writer-node"]}}',
      message_template: '{{run.outputs["append-up"]}}',
    };
    const nodes: WorkflowNode[] = [
      node,
      gate,
      ...inputNodes(['append-up', 'prompt-up', 'system-up']),
    ];
    const explicit: Pair[] = [['append-up', 'writer-node']];
    const graph: GraphCase = {
      seed: 102,
      ids: nodes.map((entry) => entry.id),
      pairs: [
        ...explicit,
        ['system-up', 'writer-node'],
        ['prompt-up', 'writer-node'],
        ['writer-node', 'gate'],
        ['append-up', 'gate'],
      ],
    };
    const configs: PlanConfig[] = [
      { kind: 'agent', node, resolvedAgent: agent },
      { kind: 'human_in_the_loop', node: gate },
      ...inputNodes(['append-up', 'prompt-up', 'system-up']).map(
        (input): PlanConfig => ({ kind: 'input', node: input }),
      ),
    ];
    const sites = new Map([
      [
        'writer-node',
        [
          outputSite('writer-node', 'prompt_template', 'prompt-up'),
          outputSite('writer-node', 'system_prompt_append', 'append-up'),
        ],
      ],
      [
        'gate',
        [
          outputSite('gate', 'assignee', 'writer-node'),
          outputSite('gate', 'message_template', 'append-up'),
        ],
      ],
    ]);
    expect(actualPlan(nodes, explicit, {}, [agent])).toEqual(expectedPlan(graph, configs, sites));
  });

  it('derived condition branches/default and handled duplicate edges keep exact priority', () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'route',
        type: 'condition',
        expression: 'true',
        branches: [{ when: true, target_node: 'low' }],
        default: 'high',
      },
      ...inputNodes(['low', 'high', 'independent']),
    ];
    const actual = actualPlan(nodes, [['route:true', 'low']]);
    const graph: GraphCase = {
      seed: 103,
      ids: nodes.map((node) => node.id),
      pairs: [
        ['route', 'low'],
        ['route', 'high'],
      ],
    };
    const configs: PlanConfig[] = nodes.map((node) =>
      node.type === 'condition'
        ? { kind: 'condition', node }
        : { kind: 'input', node: { id: node.id, type: 'input' } },
    );
    expect(actual).toEqual(expectedPlan(graph, configs));
  });

  it.each([
    { ids: ['a'], pairs: [['a', 'a']] },
    {
      ids: ['a', 'b'],
      pairs: [
        ['a', 'b'],
        ['b', 'a'],
      ],
    },
    {
      ids: ['free', 'a', 'b'],
      pairs: [
        ['a', 'b'],
        ['b', 'a'],
      ],
    },
    ...Array.from({ length: 8 }, (_, seed) => {
      const ids = generated(seed, seed + 3).ids;
      return {
        ids,
        pairs: ids.map((id, index): Pair => [id, requireValue(ids[(index + 1) % ids.length])]),
      };
    }),
  ] satisfies readonly { ids: readonly string[]; pairs: readonly Pair[] }[])(
    'cycles still raise only the typed deterministic graph error: %j',
    ({ ids, pairs }) => {
      let caught: unknown;
      try {
        actualPlan(inputNodes(ids), pairs);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WorkflowGraphError);
      if (!(caught instanceof WorkflowGraphError)) throw new Error('expected graph refusal');
      expect(caught.code).toBe('invalid_graph');
      expect(caught.issues.map((issue) => issue.kind)).toEqual(['cycle']);
      expect(caught.issues[0]?.message).toBe(
        'the workflow has a dependency cycle: ' + caught.issues[0]?.field,
      );
      if (ids.length === 1) expect(caught.issues[0]?.field).toBe('a → a');
      if (ids.includes('a') && ids.includes('b')) expect(caught.issues[0]?.field).toBe('b → a → b');
    },
  );

  it.each([
    [
      { id: 'a', type: 'parallel', parallel_of: ['b'] },
      { id: 'b', type: 'parallel', parallel_of: ['a'] },
    ],
    [
      {
        id: 'a',
        type: 'condition',
        expression: 'true',
        branches: [{ when: true, target_node: 'b' }],
      },
      {
        id: 'b',
        type: 'condition',
        expression: 'true',
        branches: [{ when: true, target_node: 'a' }],
      },
    ],
    [
      {
        id: 'a',
        type: 'human_gate',
        gate_type: 'approval',
        message_template: '{{run.outputs["b"]}}',
      },
      { id: 'b', type: 'human_gate', gate_type: 'approval', assignee: '{{run.outputs["a"]}}' },
    ],
  ] satisfies readonly (readonly WorkflowNode[])[])(
    'cycles created solely by materialized edges remain refused: %j',
    (...nodes) => {
      let caught: unknown;
      try {
        actualPlan(nodes, []);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WorkflowGraphError);
      if (!(caught instanceof WorkflowGraphError))
        throw new Error('expected materialized cycle refusal');
      expect(caught.issues.map((issue) => issue.kind)).toEqual(['cycle']);
      expect(caught.issues[0]?.field).toBe('b → a → b');
    },
  );

  it('an empty authored workflow remains refused by admission', () => {
    expect(() =>
      parseWorkflow(
        JSON.stringify({ schema_version: '1.0', workflow: { id: 'empty', nodes: [], edges: [] } }),
      ),
    ).toThrow(WorkflowValidationError);
  });
});
