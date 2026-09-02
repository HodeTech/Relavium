import { describe, expect, it } from 'vitest';

import { buildRunPlan } from './dag.js';
import { WorkflowGraphError } from './errors.js';
import { MAX_SOURCE_CHARS, parseWorkflow } from './parser.js';

function b36(n: number): string {
  return n.toString(36);
}

/** 1 inline agent with T tools, N agent nodes each narrowing to a granted tool. */
function bigGrant(nodeCount: number, toolCount: number): string {
  const tools: string[] = [];
  for (let i = 0; i < toolCount; i++) tools.push(`zz${b36(i)}`);
  const nodes: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push(
      `    - { id: n${b36(i)}, type: agent, agent_ref: w, prompt_template: 'p', tools: [zz0] }`,
    );
  }
  return `schema_version: '1.0'
workflow:
  id: big
  agents:
    - { id: w, model: m, provider: anthropic, system_prompt: 's', tools: [${tools.join(',')}] }
  nodes:
${nodes.join('\n')}
  edges: []
`;
}

describe('repro', () => {
  it('A: 500 nodes x 130k agent tools', () => {
    const yaml = bigGrant(500, 130_000);
    console.log(
      'source chars',
      yaml.length,
      'limit',
      MAX_SOURCE_CHARS,
      'under?',
      yaml.length <= MAX_SOURCE_CHARS,
    );
    const t0 = performance.now();
    const def = parseWorkflow(yaml);
    const t1 = performance.now();
    const p = buildRunPlan(def);
    const t2 = performance.now();
    console.log('parseWorkflow ms', (t1 - t0).toFixed(0), 'buildRunPlan ms', (t2 - t1).toFixed(0));
    expect(p.order).toHaveLength(500);
  }, 300_000);

  it('B: issue explosion — one node with 200k ungranted tools', () => {
    const tools: string[] = [];
    for (let i = 0; i < 200_000; i++) tools.push('a');
    const yaml = `schema_version: '1.0'
workflow:
  id: boom
  agents:
    - { id: w, model: m, provider: anthropic, system_prompt: 's', tools: [x] }
  nodes:
    - { id: n0, type: agent, agent_ref: w, prompt_template: 'p', tools: [${tools.join(',')}] }
  edges: []
`;
    console.log('B source chars', yaml.length, 'under?', yaml.length <= MAX_SOURCE_CHARS);
    const def = parseWorkflow(yaml);
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    let err: unknown;
    try {
      buildRunPlan(def);
    } catch (e) {
      err = e;
    }
    const t1 = performance.now();
    expect(err).toBeInstanceOf(WorkflowGraphError);
    const ge = err as WorkflowGraphError;
    const after = process.memoryUsage().heapUsed;
    const bytes = ge.issues.reduce((acc, i) => acc + i.field.length * 2 + i.message.length * 2, 0);
    console.log(
      'B issues',
      ge.issues.length,
      'buildRunPlan ms',
      (t1 - t0).toFixed(0),
      'string bytes MB',
      (bytes / 1e6).toFixed(1),
      'heap delta MB',
      ((after - before) / 1e6).toFixed(1),
      'message len',
      ge.message.length,
    );
  }, 300_000);

  it('C: over-ceiling file still pays the wiring pass', () => {
    const yaml = bigGrant(5_000, 20_000);
    console.log('C source chars', yaml.length, 'under?', yaml.length <= MAX_SOURCE_CHARS);
    const def = parseWorkflow(yaml);
    const t0 = performance.now();
    let err: unknown;
    try {
      buildRunPlan(def);
    } catch (e) {
      err = e;
    }
    const t1 = performance.now();
    console.log(
      'C buildRunPlan ms',
      (t1 - t0).toFixed(0),
      'issues',
      (err as WorkflowGraphError).issues.length,
    );
    expect(err).toBeInstanceOf(WorkflowGraphError);
  }, 300_000);
});
