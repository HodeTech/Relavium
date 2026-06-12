import { describe, expect, it } from 'vitest';

import { parseWorkflow } from '../parser.js';

import { collectReferences } from './collect.js';

describe('collectReferences — site categories', () => {
  it('collects a human_gate `assignee` and `message_template` as node-text', () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: who
      type: string
  nodes:
    - id: g
      type: human_gate
      gate_type: review
      assignee: '{{inputs.who}}'
      message_template: 'hi {{inputs.who}}'
  edges: []`);
    const byLocation = new Map(collectReferences(wf).map((s) => [s.location, s.category]));
    expect(byLocation.get('node `g`.assignee')).toBe('node-text');
    expect(byLocation.get('node `g`.message_template')).toBe('node-text');
  });

  it('tags context values, input defaults, and inline agent system prompts by category', () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: p
      type: string
      default: 'fallback {{inputs.p}}'
  context:
    - key: c
      value: '{{inputs.p}}'
  agents:
    - id: ag
      name: Ag
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: 'sys {{ctx.c}}'
  nodes:
    - id: n
      type: input
  edges: []`);
    const byLocation = new Map(collectReferences(wf).map((s) => [s.location, s.category]));
    expect(byLocation.get('context `c`.value')).toBe('context-value');
    expect(byLocation.get('input `p`.default')).toBe('input-default');
    expect(byLocation.get('agent `ag`.system_prompt')).toBe('agent-text');
  });
});
