import { describe, expect, it } from 'vitest';

import { WORKFLOW_NODE_TYPES } from './constants.js';
import { NodeSchema } from './node.js';

describe('NodeSchema', () => {
  it('the union covers exactly the eight authored node types', () => {
    const unionTypes = NodeSchema.options.map((o) => o.shape.type.value).sort();
    expect(unionTypes).toEqual([...WORKFLOW_NODE_TYPES].sort());
  });

  it('accepts a minimal valid node of each authored type', () => {
    const samples: unknown[] = [
      { id: 'in', type: 'input' },
      { id: 'a', type: 'agent', agent_ref: 'my-agent' },
      { id: 'g', type: 'human_gate', gate_type: 'approval' },
      {
        id: 'c',
        type: 'condition',
        expression: 'x > 1',
        branches: [{ when: true, target_node: 'a' }],
      },
      { id: 't', type: 'transform', transform: '{ x: 1 }' },
      { id: 'p', type: 'parallel', parallel_of: ['a'] },
      { id: 'm', type: 'merge', merge_strategy: 'concat' },
      { id: 'o', type: 'output' },
    ];
    for (const sample of samples) {
      expect(NodeSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('rejects a reserved/engine-only type that is not authorable in v1.0', () => {
    expect(NodeSchema.safeParse({ id: 'l', type: 'loop' }).success).toBe(false);
    expect(NodeSchema.safeParse({ id: 's', type: 'subworkflow' }).success).toBe(false);
    expect(NodeSchema.safeParse({ id: 't', type: 'tool' }).success).toBe(false);
  });

  it('rejects a non-kebab-case node id', () => {
    expect(NodeSchema.safeParse({ id: 'My_Node', type: 'input' }).success).toBe(false);
  });

  it('rejects an agent node missing agent_ref', () => {
    expect(NodeSchema.safeParse({ id: 'a', type: 'agent' }).success).toBe(false);
  });

  it('rejects a human_gate with an invalid timeout_action', () => {
    expect(
      NodeSchema.safeParse({
        id: 'g',
        type: 'human_gate',
        gate_type: 'approval',
        timeout_action: 'fail',
      }).success,
    ).toBe(false);
  });
});
