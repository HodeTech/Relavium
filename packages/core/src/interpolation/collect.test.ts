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

  it('tags context values and inline agent system prompts by category', () => {
    // **`input-default` is no longer among them** (ADR-0083 §3): a default may take no `{{ }}` references,
    // so `parseWorkflow` can never produce that site. The category survives in the collector because the
    // collector is a pure function over a workflow object and its removal is a separate cleanup — noted
    // there rather than left as silent dead code.
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: p
      type: string
      default: 'a literal fallback'
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
    expect(byLocation.has('input `p`.default')).toBe(false); // a literal default is not a reference site
    expect(byLocation.get('agent `ag`.system_prompt')).toBe('agent-text');
  });
});

describe('collectReferences — the sites `parseWorkflow` can no longer produce', () => {
  it('still yields an `input-default` site for a HAND-BUILT workflow object', () => {
    // The category is deliberately kept (ADR-0083 §3, and the note on `ReferenceSiteCategory`) for exactly
    // this caller: a pure function over a `Workflow` object, not everything that reaches it through the
    // schema. A review pointed out that keeping it was argued for and then pinned by nothing — the rewritten
    // schema test asserts the site is ABSENT, which holds trivially for a literal default — so the arm could
    // be deleted later in silence, which is the opposite of a recorded decision.
    const wf = {
      schema_version: '1.0',
      workflow: {
        id: 'w',
        inputs: [{ name: 'p', type: 'string', default: 'fallback {{ctx.c}}' }],
        context: [{ key: 'c', value: 'x' }],
        nodes: [{ id: 'n', type: 'input' }],
        edges: [],
      },
    } as unknown as Parameters<typeof collectReferences>[0];

    const sites = collectReferences(wf);
    const site = sites.find((s) => s.location === 'input `p`.default');
    expect(site?.category).toBe('input-default');
  });
});
