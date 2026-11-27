/**
 * The `/workflows` popup's detail is built from the very parse a run makes ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4):
 * the description, the inputs a run would ask (what is required), the nodes in the order a run reaches them (a human gate says what it is and how long it
 * waits), and a bound on how much is handed over. The function is pure, so these tests read a parsed document and the plain data it gives.
 */
import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { WORKFLOW_DETAIL_ITEMS_MAX, buildWorkflowDetail } from './workflow-detail.js';

const parse = (yaml: string): WorkflowDefinition => parseWorkflow(yaml, { source: 'w.yaml' });

describe('the detail of a workflow', () => {
  it('carries the description as written, and the inputs a run would ask: required only when it has no default', () => {
    const detail = buildWorkflowDetail(
      parse(`schema_version: '1.0'
workflow:
  id: notes
  description: Drafts release notes for a version.
  inputs:
    - { name: version, type: string, required: true }
    - { name: channel, type: string, required: true, default: stable }
    - { name: dry, type: boolean }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`),
    );
    expect(detail.description).toBe('Drafts release notes for a version.');
    expect(detail.inputs).toEqual([
      { name: 'version', type: 'string', required: true },
      { name: 'channel', type: 'string', required: false },
      { name: 'dry', type: 'boolean', required: false },
    ]);
    expect(detail.inputsMore).toBe(0);
  });

  it('has no description and no inputs when the workflow declares none', () => {
    const detail = buildWorkflowDetail(
      parse(`schema_version: '1.0'
workflow:
  id: bare
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`),
    );
    expect(detail.description).toBeUndefined();
    expect(detail.inputs).toEqual([]);
  });

  it('lists the nodes in the order the edges reach them, not the order the file declares them, and says what a human gate is and how long it waits', () => {
    const detail = buildWorkflowDetail(
      parse(`schema_version: '1.0'
workflow:
  id: gated
  nodes:
    - { id: out, type: output }
    - { id: approve, type: human_gate, gate_type: approval, timeout_ms: 600000 }
    - { id: start, type: input }
    - { id: confirm, type: human_gate, gate_type: approval }
    - { id: slow, type: human_gate, gate_type: approval, timeout_ms: 7200000 }
  edges:
    - { from: start, to: approve }
    - { from: approve, to: confirm }
    - { from: confirm, to: slow }
    - { from: slow, to: out }
`),
    );
    expect(detail.nodes).toEqual([
      { id: 'start' },
      { id: 'approve', note: 'approval, 10 min' },
      { id: 'confirm', note: 'approval' },
      { id: 'slow', note: 'approval, 2 h' },
      { id: 'out' },
    ]);
    expect(detail.nodesMore).toBe(0);
  });

  it('gives a wait that is not a whole minute in seconds', () => {
    const detail = buildWorkflowDetail(
      parse(`schema_version: '1.0'
workflow:
  id: quick
  nodes:
    - { id: start, type: input }
    - { id: ask, type: human_gate, gate_type: approval, timeout_ms: 90000 }
    - { id: out, type: output }
  edges:
    - { from: start, to: ask }
    - { from: ask, to: out }
`),
    );
    expect(detail.nodes.find((node) => node.id === 'ask')?.note).toBe('approval, 90 s');
  });

  it('lists every node once even when a cycle leaves some unreachable from the start: the parser refuses one, this reads what it is given', () => {
    const base = parse(`schema_version: '1.0'
workflow:
  id: loop
  nodes:
    - { id: start, type: input }
    - { id: a, type: output }
    - { id: b, type: output }
  edges:
    - { from: start, to: a }
`);
    const cyclic: WorkflowDefinition = {
      ...base,
      workflow: {
        ...base.workflow,
        edges: [
          { from: 'start', to: 'a' },
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      },
    };
    expect(buildWorkflowDetail(cyclic).nodes.map((node) => node.id)).toEqual(['start', 'a', 'b']);
  });

  it('hands over at most the bound of inputs and nodes and counts the rest, so a document of hundreds of nodes costs the popup a few rows', () => {
    const total = WORKFLOW_DETAIL_ITEMS_MAX + 7;
    const inputs = Array.from(
      { length: total },
      (_, at) => `    - { name: field${String(at)}, type: string }`,
    ).join('\n');
    const nodes = Array.from(
      { length: total },
      (_, at) => `    - { id: n${String(at)}, type: output }`,
    ).join('\n');
    const detail = buildWorkflowDetail(
      parse(`schema_version: '1.0'
workflow:
  id: wide
  inputs:
${inputs}
  nodes:
    - { id: start, type: input }
${nodes}
  edges:
    - { from: start, to: n0 }
`),
    );
    expect(detail.inputs).toHaveLength(WORKFLOW_DETAIL_ITEMS_MAX);
    expect(detail.inputsMore).toBe(7);
    expect(detail.nodes).toHaveLength(WORKFLOW_DETAIL_ITEMS_MAX);
    expect(detail.nodesMore).toBe(8); // the start node and the 31 others, less the 24 shown
  });
});

// ---- the order of the chain on a document the author wrote (review round 1, X-1) ------------------------------------------------

/** The old algorithm, as it was before the heap: the oracle the new order is held to on every small graph (quadratic, and fine for a dozen nodes). */
function referenceOrder(
  ids: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
): string[] {
  const known = new Set(ids);
  const waiting = new Map<string, number>(ids.map((id) => [id, 0]));
  const following = new Map<string, string[]>();
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    waiting.set(edge.to, (waiting.get(edge.to) ?? 0) + 1);
    following.set(edge.from, [...(following.get(edge.from) ?? []), edge.to]);
  }
  const order: string[] = [];
  let ready = ids.filter((id) => waiting.get(id) === 0);
  for (let next = ready.shift(); next !== undefined; next = ready.shift()) {
    order.push(next);
    for (const after of following.get(next) ?? []) {
      const left = (waiting.get(after) ?? 0) - 1;
      waiting.set(after, left);
      if (left === 0) ready = [...ready, after].sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    }
  }
  const placed = new Set(order);
  return [...order, ...ids.filter((id) => !placed.has(id))];
}

/** A definition over these node ids and edges, built without the parser (which is not what is measured). */
function definitionOver(
  ids: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
): WorkflowDefinition {
  const base = parse(`schema_version: '1.0'
workflow:
  id: graph
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`);
  return {
    ...base,
    workflow: {
      ...base.workflow,
      nodes: ids.map((id) => ({ id, type: 'output' as const })),
      edges: [...edges],
    },
  };
}

const idsOf = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `n${String(at)}`);
const shown = (definition: WorkflowDefinition): string[] =>
  buildWorkflowDetail(definition).nodes.map((node) => node.id);

describe('the order of the chain is the same on every small graph, and cheap on a huge one', () => {
  it.each([
    [
      'a chain declared backwards',
      ['d', 'c', 'b', 'a'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
      ],
      ['a', 'b', 'c', 'd'],
    ],
    [
      'a diamond',
      ['join', 'left', 'right', 'top'],
      [
        ['top', 'left'],
        ['top', 'right'],
        ['left', 'join'],
        ['right', 'join'],
      ],
      ['top', 'left', 'right', 'join'],
    ],
    [
      'two starts, ties by declared order',
      ['y', 'x', 'z'],
      [
        ['x', 'z'],
        ['y', 'z'],
      ],
      ['y', 'x', 'z'],
    ],
    [
      'a cycle behind a start',
      ['s', 'a', 'b'],
      [
        ['s', 'a'],
        ['a', 'b'],
        ['b', 'a'],
      ],
      ['s', 'a', 'b'],
    ],
    [
      'an edge to a node nobody declared',
      ['a', 'b'],
      [
        ['a', 'ghost'],
        ['ghost', 'b'],
      ],
      ['a', 'b'],
    ],
    [
      'a self-loop',
      ['a', 'b'],
      [
        ['a', 'a'],
        ['a', 'b'],
      ],
      ['a', 'b'],
    ],
    [
      'a repeated edge',
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['a', 'b'],
        ['b', 'c'],
      ],
      ['a', 'b', 'c'],
    ],
  ] as const)('%s', (_name, ids, edges, expected) => {
    const pairs = edges.map(([from, to]) => ({ from, to }));
    expect(shown(definitionOver(ids, pairs))).toEqual(expected);
    expect(referenceOrder(ids, pairs), 'the old algorithm says the same').toEqual(expected);
  });

  it('gives the old algorithm’s order on 400 seeded random graphs of up to 12 nodes (cycles, repeated and dangling edges included)', () => {
    let seed = 20_261_127;
    const next = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    for (let round = 0; round < 400; round += 1) {
      const count = 1 + next(12);
      const ids = idsOf(count);
      const edges = Array.from({ length: next(2 * count + 1) }, () => ({
        from: next(count + 1) === count ? 'ghost' : (ids[next(count)] ?? 'ghost'),
        to: ids[next(count)] ?? 'ghost',
      }));
      const expected = referenceOrder(ids, edges).slice(0, WORKFLOW_DETAIL_ITEMS_MAX);
      expect(shown(definitionOver(ids, edges)), `round ${String(round)}`).toEqual(expected);
    }
  });

  it('counts the nodes it leaves out whatever their order: 30 nodes show 24 and say 6 more', () => {
    const ids = idsOf(30);
    const detail = buildWorkflowDetail(definitionOver(ids, []));
    expect(detail.nodes).toHaveLength(WORKFLOW_DETAIL_ITEMS_MAX);
    expect(detail.nodesMore).toBe(6);
  });

  it.each([
    ['a star of 8,000 nodes (one root, every other node behind it)', 8_000],
    ['a chain of 8,000 nodes', 8_000],
    ['a dense layered graph of 3,000 nodes (every node leads to the next ten)', 3_000],
  ] as const)(
    '%s costs the popup well under a second, not minutes (the UI thread is stuck while it runs)',
    (name, count) => {
      const ids = idsOf(count);
      const edges: { from: string; to: string }[] = [];
      for (let at = 0; at < count; at += 1) {
        if (name.startsWith('a star')) {
          if (at > 0) edges.push({ from: 'n0', to: `n${String(at)}` });
        } else if (name.startsWith('a chain')) {
          if (at > 0) edges.push({ from: `n${String(at - 1)}`, to: `n${String(at)}` });
        } else {
          for (let ahead = 1; ahead <= 10 && at + ahead < count; ahead += 1)
            edges.push({ from: `n${String(at)}`, to: `n${String(at + ahead)}` });
        }
      }
      const definition = definitionOver(ids, edges);
      const started = performance.now();
      const detail = buildWorkflowDetail(definition);
      const took = performance.now() - started;
      expect(took, `${name} took ${String(Math.round(took))} ms`).toBeLessThan(500);
      expect(detail.nodes.map((node) => node.id).slice(0, 3)).toEqual(['n0', 'n1', 'n2']);
      expect(detail.nodes).toHaveLength(WORKFLOW_DETAIL_ITEMS_MAX);
      expect(detail.nodesMore).toBe(count - WORKFLOW_DETAIL_ITEMS_MAX);
    },
  );
});
