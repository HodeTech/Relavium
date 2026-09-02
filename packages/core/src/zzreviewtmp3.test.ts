import { describe, expect, it } from 'vitest';
import { buildRunPlan } from './dag.js';
import { parseWorkflow } from './parser.js';

function b36(n: number): string {
  return n.toString(36);
}

/** Pre-existing shape: one agent with a HUGE system_prompt, N nodes referencing it. */
function bigPrompt(nodeCount: number, promptChars: number): string {
  const prompt = 'w '.repeat(promptChars / 2);
  const nodes: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push(`    - { id: n${b36(i)}, type: agent, agent_ref: w, prompt_template: 'p' }`);
  }
  return `schema_version: '1.0'
workflow:
  id: big
  agents:
    - { id: w, model: m, provider: anthropic, system_prompt: '${prompt}' }
  nodes:
${nodes.join('\n')}
  edges: []
`;
}

describe('pre-existing amplification', () => {
  it('500 nodes x ~900k-char system_prompt', () => {
    const yaml = bigPrompt(500, 900_000);
    console.log('D source chars', yaml.length);
    const t0 = performance.now();
    const def = parseWorkflow(yaml);
    const t1 = performance.now();
    const p = buildRunPlan(def);
    const t2 = performance.now();
    console.log(
      'D parseWorkflow ms',
      (t1 - t0).toFixed(0),
      'buildRunPlan ms',
      (t2 - t1).toFixed(0),
    );
    expect(p.order).toHaveLength(500);
  }, 300_000);
});
