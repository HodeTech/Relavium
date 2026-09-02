import { describe, expect, it } from 'vitest';
import { WorkflowSchema } from '@relavium/shared';
import { LineCounter } from 'yaml';
import { decodeHardenedYaml } from './yaml-decode.js';

function b36(n: number): string {
  return n.toString(36);
}

function mk(toolCount: number): string {
  const tools: string[] = [];
  for (let i = 0; i < toolCount; i++) tools.push(`t${b36(i)}`);
  return `schema_version: '1.0'
workflow:
  id: big
  agents:
    - { id: w, model: m, provider: anthropic, system_prompt: 's', tools: [${tools.join(',')}] }
  nodes:
    - { id: n0, type: agent, agent_ref: w, prompt_template: 'p', tools: [t0] }
  edges: []
`;
}

describe('probe', () => {
  for (const n of [1000, 10_000, 20_000, 50_000, 100_000, 130_000]) {
    it(`tools=${n}`, () => {
      const raw = decodeHardenedYaml(mk(n), new LineCounter());
      const r = WorkflowSchema.safeParse(raw);
      if (!r.success) {
        console.log(n, 'FAIL', JSON.stringify(r.error.issues.slice(0, 3), null, 1).slice(0, 900));
      } else {
        console.log(n, 'OK');
      }
      expect(true).toBe(true);
    }, 300_000);
  }
});
