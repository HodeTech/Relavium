import { describe, expect, it } from 'vitest';

import type { Agent } from '@relavium/shared';

import { buildRunPlan, type BuildRunPlanOptions } from './dag.js';
import { WorkflowGraphError, WorkflowSecretLeakError } from './errors.js';
import { parseWorkflow } from './parser.js';
import type { RunPlan } from './run-plan.js';

/** Wrap a `workflow:` body into a full v1.0 document. */
function doc(body: string): string {
  return `schema_version: '1.0'\nworkflow:\n${body}`;
}

/** Parse + build in one step (the normal pipeline order). */
function plan(yaml: string, opts?: BuildRunPlanOptions): RunPlan {
  return buildRunPlan(parseWorkflow(yaml), opts);
}

/** Build expecting a graph error; returns it narrowed for assertions, or throws if none/other. */
function expectGraphError(yaml: string, opts?: BuildRunPlanOptions): WorkflowGraphError {
  try {
    plan(yaml, opts);
  } catch (err) {
    if (err instanceof WorkflowGraphError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected a WorkflowGraphError, but build succeeded');
}

/** Assert that every dependency edge orders producer before consumer in the topological order. */
function assertTopo(p: RunPlan): void {
  const pos = new Map(p.order.map((id, i) => [id, i] as const));
  expect(p.order).toHaveLength(p.vertices.size);
  for (const vertex of p.vertices.values()) {
    for (const dep of vertex.dependencies) {
      const a = pos.get(dep);
      const b = pos.get(vertex.id);
      if (a === undefined || b === undefined) {
        throw new Error(`missing topological position for \`${dep}\` or \`${vertex.id}\``);
      }
      expect(a).toBeLessThan(b);
    }
  }
}

describe('buildRunPlan — valid topological orders', () => {
  const SEQUENTIAL = doc(`  id: seq
  nodes:
    - { id: start, type: input }
    - { id: step-a, type: transform, transform: 'a' }
    - { id: step-b, type: transform, transform: 'b' }
    - { id: done, type: output }
  edges:
    - { from: start, to: step-a }
    - { from: step-a, to: step-b }
    - { from: step-b, to: done }`);

  it('orders a sequential chain and wires dependencies/dependents', () => {
    const p = plan(SEQUENTIAL);
    expect(p.workflowId).toBe('seq');
    expect(p.order).toEqual(['start', 'step-a', 'step-b', 'done']);
    assertTopo(p);
    expect(p.vertices.get('step-b')?.dependencies).toEqual(['step-a']);
    expect(p.vertices.get('step-a')?.dependents).toEqual(['step-b']);
  });

  it('is deterministic — the same workflow yields a deep-equal order', () => {
    expect(plan(SEQUENTIAL).order).toEqual(plan(SEQUENTIAL).order);
  });

  it('breaks ties by authored order across the whole ready set (not discovery order)', () => {
    const p = plan(
      doc(`  id: tie
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
    - { id: c, type: output }
  edges:
    - { from: a, to: b }`),
    );
    // a(0) and c(2) start ready; after a runs, b(1) becomes ready and must precede c(2) by authored
    // index — a discovery-order (FIFO) walk would wrongly emit [a, c, b].
    expect(p.order).toEqual(['a', 'b', 'c']);
  });

  it('orders a parallel fan-out / fan-in graph and expands parallel→fan_out, merge→fan_in', () => {
    const p = plan(
      doc(`  id: par
  max_parallel: 4
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [branch-a, branch-b] }
    - { id: branch-a, type: transform, transform: 'a' }
    - { id: branch-b, type: transform, transform: 'b' }
    - { id: join, type: merge, merge_strategy: concat }
    - { id: done, type: output }
  edges:
    - { from: start, to: fan }
    - { from: branch-a, to: join }
    - { from: branch-b, to: join }
    - { from: join, to: done }`),
    );
    assertTopo(p);
    expect(p.maxParallel).toBe(4);

    const fan = p.vertices.get('fan');
    expect(fan?.type).toBe('fan_out');
    expect(fan?.config).toMatchObject({ kind: 'fan_out', branchNodeIds: ['branch-a', 'branch-b'] });
    // The materialized fan-out edges make both branches depend on the split.
    expect(p.vertices.get('branch-a')?.dependencies).toContain('fan');
    expect(p.vertices.get('branch-b')?.dependencies).toContain('fan');

    const join = p.vertices.get('join');
    expect(join?.type).toBe('fan_in');
    expect(join?.config).toMatchObject({
      kind: 'fan_in',
      joinStrategy: 'wait_all',
      mergeStrategy: 'concat',
    });
  });

  it('exposes fan_in branchNodeIds in parallel_of order, not authored order', () => {
    const p = plan(
      doc(`  id: branchorder
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [b, a] }
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: transform, transform: '2' }
    - { id: join, type: merge, merge_strategy: concat }
  edges:
    - { from: start, to: fan }
    - { from: a, to: join }
    - { from: b, to: join }`),
    );
    // parallel_of declares [b, a]; authored order is [a, b]; the merge's dependencies sort to [a, b].
    // The fan_in must surface branches in parallel_of order so merge_fn/concat is deterministic.
    expect(p.vertices.get('join')?.config).toMatchObject({
      kind: 'fan_in',
      branchNodeIds: ['b', 'a'],
    });
  });

  it('falls back to authored branch order for a merge with no paired parallel', () => {
    const p = plan(
      doc(`  id: nopair
  nodes:
    - { id: x, type: transform, transform: '1' }
    - { id: y, type: transform, transform: '2' }
    - { id: join, type: merge, merge_strategy: concat }
  edges:
    - { from: y, to: join }
    - { from: x, to: join }`),
    );
    expect(p.vertices.get('join')?.config).toMatchObject({
      kind: 'fan_in',
      branchNodeIds: ['x', 'y'],
    });
  });

  it('carries the merge_fn for a custom merge (wait_all join)', () => {
    const p = plan(
      doc(`  id: custom
  nodes:
    - { id: fan, type: parallel, parallel_of: [a, b] }
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: transform, transform: '2' }
    - { id: join, type: merge, merge_strategy: custom, merge_fn: 'branches' }
  edges:
    - { from: a, to: join }
    - { from: b, to: join }`),
    );
    expect(p.vertices.get('join')?.config).toMatchObject({
      kind: 'fan_in',
      joinStrategy: 'wait_all',
      mergeStrategy: 'custom',
      mergeFn: 'branches',
    });
  });

  it('derives join_strategy wait_first for merge_strategy first', () => {
    const p = plan(
      doc(`  id: first
  nodes:
    - { id: fan, type: parallel, parallel_of: [a, b] }
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: transform, transform: '2' }
    - { id: join, type: merge, merge_strategy: first }
  edges:
    - { from: a, to: join }
    - { from: b, to: join }`),
    );
    expect(p.vertices.get('join')?.config).toMatchObject({
      kind: 'fan_in',
      joinStrategy: 'wait_first',
      mergeStrategy: 'first',
    });
  });

  it('orders a conditional graph and maps human_gate→human_in_the_loop', () => {
    const p = plan(
      doc(`  id: cond
  nodes:
    - { id: start, type: input }
    - { id: gate, type: condition, expression: 'run.outputs["start"].ok', branches: [{ when: true, target_node: approve }, { when: false, target_node: reject }] }
    - { id: approve, type: human_gate, gate_type: approval }
    - { id: reject, type: output }
  edges:
    - { from: start, to: gate }
    - { from: 'gate:true', to: approve }
    - { from: 'gate:false', to: reject }`),
    );
    assertTopo(p);
    expect(p.vertices.get('gate')?.type).toBe('condition');
    expect(p.vertices.get('approve')?.type).toBe('human_in_the_loop');
    expect(p.vertices.get('gate')?.dependents).toEqual(['approve', 'reject']);
  });

  it('materializes a dependency edge from a condition branch / default (no explicit edge needed)', () => {
    const p = plan(
      doc(`  id: condwire
  nodes:
    - { id: start, type: input }
    - { id: gate, type: condition, expression: 'x', branches: [{ when: true, target_node: yes-node }], default: no-node }
    - { id: yes-node, type: output }
    - { id: no-node, type: output }
  edges:
    - { from: start, to: gate }`),
    );
    assertTopo(p);
    // No `gate:true → …` edge authored — routing comes solely from branches/default, yet it is wired.
    expect(p.vertices.get('gate')?.dependents).toEqual(['yes-node', 'no-node']);
    expect(p.vertices.get('yes-node')?.dependencies).toEqual(['gate']);
    expect(p.vertices.get('no-node')?.dependencies).toEqual(['gate']);
  });

  it('leaves a dangling {{run.outputs["ghost"]}} reference to the runtime resolver (no build error)', () => {
    const p = plan(
      doc(`  id: ghostref
  agents:
    - { id: w, model: m, provider: anthropic, system_prompt: 's' }
  nodes:
    - { id: only, type: agent, agent_ref: w, prompt_template: 'use {{run.outputs["ghost-node"]}}' }
  edges: []`),
    );
    expect(p.order).toEqual(['only']);
    // The ghost reference adds no edge; the resolver flags it as unresolved_reference at dispatch (1.O).
    expect(p.vertices.get('only')?.dependencies).toEqual([]);
  });

  it('wires a data-dependency edge from a {{run.outputs[…]}} reference with no explicit edge', () => {
    const p = plan(
      doc(`  id: data
  agents:
    - { id: writer, model: m, provider: anthropic, system_prompt: 'write' }
  nodes:
    - { id: producer, type: agent, agent_ref: writer, prompt_template: 'go' }
    - { id: consumer, type: agent, agent_ref: writer, prompt_template: 'use {{run.outputs["producer"]}}' }
  edges: []`),
    );
    assertTopo(p);
    expect(p.order).toEqual(['producer', 'consumer']);
    expect(p.vertices.get('consumer')?.dependencies).toEqual(['producer']);
    // The consumer's template is attached un-evaluated for the run loop to resolve at dispatch.
    const sites = p.vertices.get('consumer')?.inputSites ?? [];
    expect(sites).toHaveLength(1);
    expect(sites[0]?.location).toBe('node `consumer`.prompt_template');
    expect(sites[0]?.category).toBe('node-text');
    expect(sites[0]?.references[0]).toMatchObject({ kind: 'node', identifier: 'producer' });
  });

  it('attaches every template field of a node as a separate input site', () => {
    const p = plan(
      doc(`  id: twosites
  agents:
    - { id: w, model: m, provider: anthropic, system_prompt: 's' }
  nodes:
    - { id: n, type: agent, agent_ref: w, prompt_template: 'p {{inputs.x}}', system_prompt_append: 'a {{ctx.y}}' }
  inputs:
    - { name: x, type: string }
  context:
    - { key: y, value: 'v' }
  edges: []`),
    );
    const locations = (p.vertices.get('n')?.inputSites ?? []).map((s) => s.location).sort();
    expect(locations).toEqual(['node `n`.prompt_template', 'node `n`.system_prompt_append']);
  });

  it('wires a data edge from a resolved agent system_prompt referencing a node output', () => {
    const agents = new Map<string, Agent>([
      [
        'summarizer',
        {
          id: 'summarizer',
          model: 'm',
          provider: 'anthropic',
          system_prompt: 'base {{run.outputs["scan"]}}',
        },
      ],
    ]);
    const p = plan(
      doc(`  id: ref-data
  nodes:
    - { id: scan, type: transform, transform: '1' }
    - { id: report, type: agent, agent_ref: summarizer, prompt_template: 'go' }
  edges: []`),
      { agents },
    );
    expect(p.vertices.get('report')?.dependencies).toEqual(['scan']);
    expect(p.vertices.get('report')?.config).toMatchObject({ kind: 'agent' });
  });
});

describe('buildRunPlan — graph shapes', () => {
  it('orders multiple independent roots converging on one sink', () => {
    const p = plan(
      doc(`  id: roots
  nodes:
    - { id: r1, type: input }
    - { id: r2, type: input }
    - { id: sink, type: output }
  edges:
    - { from: r1, to: sink }
    - { from: r2, to: sink }`),
    );
    assertTopo(p);
    expect(p.vertices.get('sink')?.dependencies).toEqual(['r1', 'r2']);
  });

  it('orders a diamond (top → {left,right} → bottom)', () => {
    const p = plan(
      doc(`  id: diamond
  nodes:
    - { id: top, type: input }
    - { id: left, type: transform, transform: '1' }
    - { id: right, type: transform, transform: '2' }
    - { id: bottom, type: output }
  edges:
    - { from: top, to: left }
    - { from: top, to: right }
    - { from: left, to: bottom }
    - { from: right, to: bottom }`),
    );
    assertTopo(p);
    expect(p.vertices.get('bottom')?.dependencies).toEqual(['left', 'right']);
    expect(p.order[0]).toBe('top');
  });

  it('handles fully isolated nodes (no edges)', () => {
    const p = plan(
      doc(`  id: iso
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges: []`),
    );
    expect(p.order).toEqual(['a', 'b']);
    expect(p.vertices.get('a')?.dependencies).toEqual([]);
    expect(p.vertices.get('b')?.dependencies).toEqual([]);
  });

  it('synthesizes NO fan_in for a parallel with no paired merge', () => {
    const p = plan(
      doc(`  id: nomerge
  nodes:
    - { id: start, type: input }
    - { id: fan, type: parallel, parallel_of: [a, b] }
    - { id: a, type: output }
    - { id: b, type: output }
  edges:
    - { from: start, to: fan }`),
    );
    expect(p.vertices.get('fan')?.type).toBe('fan_out');
    expect([...p.vertices.values()].some((v) => v.type === 'fan_in')).toBe(false);
    expect(p.vertices.get('a')?.dependencies).toEqual(['fan']);
  });

  it('dedupes a condition whose default equals a branch target', () => {
    const p = plan(
      doc(`  id: dedup
  nodes:
    - { id: gate, type: condition, expression: 'x', branches: [{ when: true, target_node: only }], default: only }
    - { id: only, type: output }
  edges: []`),
    );
    expect(p.vertices.get('gate')?.dependents).toEqual(['only']);
    expect(p.vertices.get('only')?.dependencies).toEqual(['gate']);
  });

  it('omits maxParallel when the workflow declares none', () => {
    const p = plan(
      doc(`  id: nocap
  nodes:
    - { id: a, type: input }
  edges: []`),
    );
    expect(p.maxParallel).toBeUndefined();
  });
});

describe('buildRunPlan — cycle detection', () => {
  it('rejects a direct cycle, naming it', () => {
    const err = expectGraphError(
      doc(`  id: cyc
  nodes:
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: transform, transform: '2' }
  edges:
    - { from: a, to: b }
    - { from: b, to: a }`),
    );
    expect(err.code).toBe('invalid_graph');
    expect(err.issues[0]?.kind).toBe('cycle');
    expect(err.issues[0]?.message).toMatch(/cycle/i);
    expect(err.issues[0]?.field).toContain('a');
    expect(err.issues[0]?.field).toContain('b');
  });

  it('rejects a self-loop', () => {
    const err = expectGraphError(
      doc(`  id: self
  nodes:
    - { id: a, type: transform, transform: '1' }
  edges:
    - { from: a, to: a }`),
    );
    expect(err.issues[0]?.kind).toBe('cycle');
  });

  it('detects a cycle routed through a condition branch with no explicit back-edge', () => {
    const err = expectGraphError(
      doc(`  id: condcycle
  nodes:
    - { id: a, type: transform, transform: '1' }
    - { id: gate, type: condition, expression: 'run.outputs["a"].ok', branches: [{ when: true, target_node: a }] }
  edges:
    - { from: a, to: gate }`),
    );
    expect(err.issues[0]?.kind).toBe('cycle');
  });

  it('names one cycle when the graph contains two disjoint cycles', () => {
    const err = expectGraphError(
      doc(`  id: twocyc
  nodes:
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: transform, transform: '2' }
    - { id: c, type: transform, transform: '3' }
    - { id: d, type: transform, transform: '4' }
  edges:
    - { from: a, to: b }
    - { from: b, to: a }
    - { from: c, to: d }
    - { from: d, to: c }`),
    );
    expect(err.issues[0]?.kind).toBe('cycle');
    // Names the cycle containing the first stuck node in authored order (a↔b); naming one suffices.
    expect(err.issues[0]?.field).toMatch(/[ab]/);
    expect(err.issues[0]?.message).toMatch(/cycle/i);
  });

  it('rejects a longer cycle through a data-dependency edge', () => {
    const err = expectGraphError(
      doc(`  id: cyc3
  agents:
    - { id: w, model: m, provider: anthropic, system_prompt: 's' }
  nodes:
    - { id: a, type: agent, agent_ref: w, prompt_template: 'use {{run.outputs["c"]}}' }
    - { id: b, type: transform, transform: '1' }
    - { id: c, type: transform, transform: '2' }
  edges:
    - { from: a, to: b }
    - { from: b, to: c }`),
    );
    expect(err.issues[0]?.kind).toBe('cycle');
  });
});

describe('buildRunPlan — endpoint and handle validation', () => {
  it('rejects an edge to a missing node', () => {
    const err = expectGraphError(
      doc(`  id: miss
  nodes:
    - { id: a, type: transform, transform: '1' }
  edges:
    - { from: a, to: ghost }`),
    );
    expect(err.issues[0]?.kind).toBe('unknown_edge_target');
    expect(err.issues[0]?.message).toContain('ghost');
  });

  it('rejects an edge whose source is not a node', () => {
    const err = expectGraphError(
      doc(`  id: missource
  nodes:
    - { id: a, type: output }
  edges:
    - { from: ghost, to: a }`),
    );
    expect(
      err.issues.some((i) => i.kind === 'unknown_edge_target' && i.message.includes('source')),
    ).toBe(true);
  });

  it('rejects a condition branch / default that targets a missing node', () => {
    const err = expectGraphError(
      doc(`  id: badtarget
  nodes:
    - { id: gate, type: condition, expression: 'x', branches: [{ when: true, target_node: ghost }], default: alsoghost }
  edges: []`),
    );
    const kinds = err.issues.map((i) => i.kind);
    expect(kinds).toContain('unknown_edge_target');
    expect(err.issues.some((i) => i.field.includes('branches[0].target_node'))).toBe(true);
    expect(err.issues.some((i) => i.field.includes('.default'))).toBe(true);
  });

  it('rejects a parallel_of member that is not a node', () => {
    const err = expectGraphError(
      doc(`  id: badpar
  nodes:
    - { id: fan, type: parallel, parallel_of: [ghost] }
  edges: []`),
    );
    expect(
      err.issues.some((i) => i.kind === 'unknown_edge_target' && i.field.includes('parallel_of')),
    ).toBe(true);
  });

  it('rejects a handle on a non-condition source', () => {
    const err = expectGraphError(
      doc(`  id: badhandle
  nodes:
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: output }
  edges:
    - { from: 'a:branch', to: b }`),
    );
    expect(err.issues[0]?.kind).toBe('invalid_handle');
  });

  it('rejects a condition handle that matches no branch', () => {
    const err = expectGraphError(
      doc(`  id: nohandle
  nodes:
    - { id: gate, type: condition, expression: 'x', branches: [{ when: true, target_node: out }] }
    - { id: out, type: output }
  edges:
    - { from: 'gate:false', to: out }`),
    );
    expect(err.issues.some((i) => i.kind === 'invalid_handle')).toBe(true);
  });

  it('accepts a numeric condition handle (when value stringified)', () => {
    const p = plan(
      doc(`  id: numhandle
  nodes:
    - { id: gate, type: condition, expression: 'x', branches: [{ when: 7, target_node: out }] }
    - { id: out, type: output }
  edges:
    - { from: 'gate:7', to: out }`),
    );
    expect(p.vertices.has('gate')).toBe(true);
  });

  it('rejects a condition handle edge whose `to` contradicts the branch target_node', () => {
    const err = expectGraphError(
      doc(`  id: mismatch
  nodes:
    - { id: gate, type: condition, expression: 'x', branches: [{ when: true, target_node: a }] }
    - { id: a, type: output }
    - { id: b, type: output }
  edges:
    - { from: 'gate:true', to: b }`),
    );
    expect(err.issues.some((i) => i.kind === 'mismatched_branch_target')).toBe(true);
    // Routing stays authoritative: the materialized edge follows the branch's target_node, not the edge.
    expect(err.issues[0]?.message).toContain('routes to `a`');
  });

  it('accepts a non-canonical numeric handle (gate:1.0 for when: 1)', () => {
    const p = plan(
      doc(`  id: numcanon
  nodes:
    - { id: gate, type: condition, expression: 'x', branches: [{ when: 1, target_node: out }] }
    - { id: out, type: output }
  edges:
    - { from: 'gate:1.0', to: out }`),
    );
    expect(p.vertices.has('gate')).toBe(true);
  });
});

describe('buildRunPlan — agent_ref resolution', () => {
  it('defers agent_ref resolution when no registry is supplied', () => {
    // `unknown-agent` is neither inline nor in a registry — with no registry, this is NOT an error.
    const p = plan(
      doc(`  id: defer
  nodes:
    - { id: n, type: agent, agent_ref: unknown-agent, prompt_template: 'go' }
  edges: []`),
    );
    expect(p.vertices.get('n')?.config).toMatchObject({ kind: 'agent' });
  });

  it('flags a dangling agent_ref when a registry is supplied', () => {
    const err = expectGraphError(
      doc(`  id: dangle
  nodes:
    - { id: n, type: agent, agent_ref: unknown-agent, prompt_template: 'go' }
  edges: []`),
      { agents: new Map() },
    );
    expect(err.issues[0]?.kind).toBe('dangling_ref');
    expect(err.issues[0]?.field).toContain('agent_ref');
  });

  it('attaches the resolved agent and its fallback chain to an agent vertex', () => {
    const agents = new Map<string, Agent>([
      [
        'writer',
        {
          id: 'writer',
          model: 'claude-opus-4-8',
          provider: 'anthropic',
          system_prompt: 'write well',
          fallback_chain: [{ model: 'gpt-5', provider: 'openai', max_attempts: 2 }],
        },
      ],
    ]);
    const p = plan(
      doc(`  id: resolved
  nodes:
    - { id: n, type: agent, agent_ref: writer, prompt_template: 'go' }
  edges: []`),
      { agents },
    );
    expect(p.vertices.get('n')?.config).toMatchObject({
      kind: 'agent',
      resolvedAgent: { id: 'writer', provider: 'anthropic' },
      fallbackChain: [{ model: 'gpt-5', provider: 'openai', max_attempts: 2 }],
    });
  });
});

describe('buildRunPlan — secret re-taint of resolved $ref agents', () => {
  // Build the secret-looking input name out of fragments — no contiguous literal (Leakwatch hygiene).
  const SECRET_INPUT = ['api', 'key'].join('_');

  it('rejects a resolved agent whose system_prompt leaks a secret input', () => {
    const agents = new Map<string, Agent>([
      [
        'leaky',
        {
          id: 'leaky',
          model: 'm',
          provider: 'anthropic',
          system_prompt: `inject {{inputs.${SECRET_INPUT}}} here`,
        },
      ],
    ]);
    let thrown: unknown;
    try {
      plan(
        doc(`  id: leak
  inputs:
    - { name: ${SECRET_INPUT}, type: secret }
  nodes:
    - { id: n, type: agent, agent_ref: leaky, prompt_template: 'go' }
  edges: []`),
        { agents },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowSecretLeakError);
    const leak = (thrown as WorkflowSecretLeakError).leaks[0];
    expect(leak?.secret).toBe(`inputs.${SECRET_INPUT}`);
    expect(leak?.location).toContain('leaky');
  });

  it('does NOT re-taint an unreferenced registry agent (only referenced ones reach a model)', () => {
    const agents = new Map<string, Agent>([
      [
        'used-clean',
        { id: 'used-clean', model: 'm', provider: 'anthropic', system_prompt: 'clean' },
      ],
      [
        'unused-leaky',
        {
          id: 'unused-leaky',
          model: 'm',
          provider: 'anthropic',
          system_prompt: `x {{inputs.${SECRET_INPUT}}}`,
        },
      ],
    ]);
    // `unused-leaky` leaks but no node references it, so the build must succeed (it never reaches a model).
    const p = plan(
      doc(`  id: unref
  inputs:
    - { name: ${SECRET_INPUT}, type: secret }
  nodes:
    - { id: n, type: agent, agent_ref: used-clean, prompt_template: 'go' }
  edges: []`),
      { agents },
    );
    expect(p.vertices.get('n')?.config).toMatchObject({ kind: 'agent' });
  });

  it('reports the first leak in authored node order, not host registry Map order', () => {
    // Registry inserted in REVERSE authored order — the reported headline leak must still follow authored order.
    const agents = new Map<string, Agent>([
      [
        'agent-b',
        {
          id: 'agent-b',
          model: 'm',
          provider: 'anthropic',
          system_prompt: `b {{inputs.${SECRET_INPUT}}}`,
        },
      ],
      [
        'agent-a',
        {
          id: 'agent-a',
          model: 'm',
          provider: 'anthropic',
          system_prompt: `a {{inputs.${SECRET_INPUT}}}`,
        },
      ],
    ]);
    let thrown: unknown;
    try {
      plan(
        doc(`  id: order
  inputs:
    - { name: ${SECRET_INPUT}, type: secret }
  nodes:
    - { id: node-a, type: agent, agent_ref: agent-a, prompt_template: 'go' }
    - { id: node-b, type: agent, agent_ref: agent-b, prompt_template: 'go' }
  edges: []`),
        { agents },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowSecretLeakError);
    // node-a is authored first → its agent is the headline leak, despite agent-b being inserted Map-first.
    expect((thrown as WorkflowSecretLeakError).leaks[0]?.location).toContain('agent-a');
  });

  it('does NOT re-check inline agents (already gated by the parser) via the registry path', () => {
    // An inline agent is parser-checked; supplying it again in the registry must not double-flag.
    const agents = new Map<string, Agent>([
      [
        'inliner',
        { id: 'inliner', model: 'm', provider: 'anthropic', system_prompt: 'clean prompt' },
      ],
    ]);
    const p = plan(
      doc(`  id: inline-ok
  agents:
    - { id: inliner, model: m, provider: anthropic, system_prompt: 'clean prompt' }
  nodes:
    - { id: n, type: agent, agent_ref: inliner, prompt_template: 'go' }
  edges: []`),
      { agents },
    );
    expect(p.vertices.get('n')?.config).toMatchObject({ kind: 'agent' });
  });
});

describe('buildRunPlan — error hygiene', () => {
  it('never echoes an identifier-shaped (secret-token-shaped) handle into a graph error', () => {
    // An identifier-charset token PASSES SAFE_NAME_LABEL, so the charset alone is not a guard; the
    // invalid-handle path must stay positional regardless. Build the token via join() (Leakwatch hygiene).
    const token = ['sk', 'live', 'DEADBEEFsecret0123456789'].join('-');
    const err = expectGraphError(
      doc(`  id: tokenhandle
  nodes:
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: output }
  edges:
    - { from: 'a:${token}', to: b }`),
    );
    expect(err.issues[0]?.kind).toBe('invalid_handle');
    expect(err.message).not.toContain(token);
    expect(JSON.stringify(err.issues)).not.toContain(token);
  });

  it('does not echo a charset-unsafe edge handle into the error', () => {
    const unsafe = ['secret', 'value'].join('/'); // contains '/', outside the safe handle charset
    const err = expectGraphError(
      doc(`  id: hyg
  nodes:
    - { id: a, type: transform, transform: '1' }
    - { id: b, type: output }
  edges:
    - { from: 'a:${unsafe}', to: b }`),
    );
    expect(err.issues[0]?.kind).toBe('invalid_handle');
    expect(JSON.stringify(err.issues)).not.toContain(unsafe);
  });

  it('attaches no cause to a graph error (no raw object that could echo a value)', () => {
    const err = expectGraphError(
      doc(`  id: nocause
  nodes:
    - { id: a, type: transform, transform: '1' }
  edges:
    - { from: a, to: a }`),
    );
    expect(err.cause).toBeUndefined();
  });

  it('carries the source label into a graph error', () => {
    try {
      buildRunPlan(
        parseWorkflow(
          doc(`  id: src
  nodes:
    - { id: a, type: transform, transform: '1' }
  edges:
    - { from: a, to: ghost }`),
        ),
        { source: 'flows/x.relavium.yaml' },
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowGraphError);
      expect((err as WorkflowGraphError).source).toBe('flows/x.relavium.yaml');
    }
  });
});
