import { describe, expect, it } from 'vitest';

import { WORKFLOW_NODE_TYPES } from './constants.js';
import { NodeSchema } from './node.js';

describe('NodeSchema', () => {
  it('the union has exactly the eight authored node types', () => {
    // Each type's acceptance is proven by "accepts a minimal valid node of each type"
    // below (so a rename fails there); the count catches an extra/missing variant without
    // reading Zod internals.
    expect(NodeSchema.options).toHaveLength(WORKFLOW_NODE_TYPES.length);
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

  it('rejects nodes missing their required per-type fields', () => {
    const invalid: unknown[] = [
      { id: 'g', type: 'human_gate' }, // missing gate_type
      { id: 'c', type: 'condition', branches: [] }, // missing expression
      { id: 'c', type: 'condition', expression: 'x' }, // missing branches
      { id: 't', type: 'transform' }, // missing transform
      { id: 'p', type: 'parallel' }, // missing parallel_of
      { id: 'p', type: 'parallel', parallel_of: [] }, // empty parallel_of
      { id: 'm', type: 'merge' }, // missing merge_strategy
      { id: 'm', type: 'merge', merge_strategy: 'best_of_n' }, // reserved, not v1.0
    ];
    for (const node of invalid) {
      expect(NodeSchema.safeParse(node).success).toBe(false);
    }
  });

  it('rejects a condition branch with a non-kebab target_node', () => {
    expect(
      NodeSchema.safeParse({
        id: 'c',
        type: 'condition',
        expression: 'x > 1',
        branches: [{ when: true, target_node: 'Not Kebab' }],
      }).success,
    ).toBe(false);
  });
});
