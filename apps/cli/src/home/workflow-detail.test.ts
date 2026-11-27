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
