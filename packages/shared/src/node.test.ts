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

  it('accepts an above-chain retry budget on condition / transform / merge (ADR-0040)', () => {
    const retry = { max: 3, backoff: 'exponential', backoff_ms: 500, retry_on: ['tool_failed'] };
    const samples: unknown[] = [
      {
        id: 'c',
        type: 'condition',
        expression: 'x',
        branches: [{ when: true, target_node: 'a' }],
        retry,
      },
      { id: 't', type: 'transform', transform: '1', retry },
      { id: 'm', type: 'merge', merge_strategy: 'concat', retry },
    ];
    for (const sample of samples) {
      expect(NodeSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('rejects a retry_on listing a non-retryable error code (ADR-0040 A.4)', () => {
    // `tool_denied` is fatal — retrying it just re-denies; the subset enum rejects it at parse.
    const bad = {
      id: 't',
      type: 'transform',
      transform: '1',
      retry: { max: 2, backoff: 'linear', retry_on: ['tool_denied'] },
    };
    expect(NodeSchema.safeParse(bad).success).toBe(false);
    // …and an empty retry_on (a budget that retries on nothing) is rejected too.
    const empty = {
      id: 't',
      type: 'transform',
      transform: '1',
      retry: { max: 2, backoff: 'linear', retry_on: [] },
    };
    expect(NodeSchema.safeParse(empty).success).toBe(false);
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

  // Each case omits exactly one required field; the error must land on THAT field, so a
  // reject can't pass for an unrelated reason.
  const missingRequired: [string, unknown][] = [
    ['gate_type', { id: 'g', type: 'human_gate' }],
    ['expression', { id: 'c', type: 'condition', branches: [{ when: true, target_node: 'a' }] }],
    ['branches', { id: 'c', type: 'condition', expression: 'x > 1' }],
    ['transform', { id: 't', type: 'transform' }],
    ['parallel_of', { id: 'p', type: 'parallel' }],
    ['merge_strategy', { id: 'm', type: 'merge' }],
    ['agent_ref', { id: 'a', type: 'agent' }],
  ];
  it.each(missingRequired)(
    'rejects a node missing required %s, with the error on that field',
    (field, node) => {
      const result = NodeSchema.safeParse(node);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes(field))).toBe(true);
      }
    },
  );

  it('rejects empty / reserved control-node values', () => {
    // condition needs >= 1 branch; parallel needs >= 1 branch; best_of_n is reserved.
    expect(
      NodeSchema.safeParse({ id: 'c', type: 'condition', expression: 'x', branches: [] }).success,
    ).toBe(false);
    expect(NodeSchema.safeParse({ id: 'p', type: 'parallel', parallel_of: [] }).success).toBe(
      false,
    );
    expect(
      NodeSchema.safeParse({ id: 'm', type: 'merge', merge_strategy: 'best_of_n' }).success,
    ).toBe(false);
  });

  it('accepts a custom merge with no merge_fn at the node level (the cross-field rule lives at WorkflowSchema)', () => {
    // A discriminated-union member can't carry a cross-field refinement, so `merge_strategy:custom`
    // without `merge_fn` is intentionally accepted here and only rejected at WorkflowSchema level.
    expect(NodeSchema.safeParse({ id: 'm', type: 'merge', merge_strategy: 'custom' }).success).toBe(
      true,
    );
  });

  it('pins condition default + when invariants', () => {
    const cond = {
      id: 'c',
      type: 'condition',
      expression: 'x > 1',
      branches: [{ when: true, target_node: 'a' }],
    };
    expect(NodeSchema.safeParse({ ...cond, default: 'Not Kebab' }).success).toBe(false); // default is a kebab node id
    expect(NodeSchema.safeParse({ ...cond, default: 'fallback-node' }).success).toBe(true);
    // a when value may be a string expression or a literal (string | number | boolean)
    expect(
      NodeSchema.safeParse({ ...cond, branches: [{ when: 'foo', target_node: 'a' }] }).success,
    ).toBe(true);
    expect(
      NodeSchema.safeParse({ ...cond, branches: [{ when: 7, target_node: 'a' }] }).success,
    ).toBe(true);
  });

  it('rejects an empty transform expression', () => {
    expect(NodeSchema.safeParse({ id: 't', type: 'transform', transform: '' }).success).toBe(false);
  });

  it('accepts an agent node with optional overrides, and a minimal one without', () => {
    expect(NodeSchema.safeParse({ id: 'a', type: 'agent', agent_ref: 'ag' }).success).toBe(true);
    expect(
      NodeSchema.safeParse({
        id: 'a',
        type: 'agent',
        agent_ref: 'ag',
        prompt_template: 'p',
        model: 'gpt-4o',
        temperature: 0.5,
        max_tokens: 500,
        tools: ['read_file'],
        timeout_ms: 30000,
        retry: { max: 2, backoff: 'linear' },
      }).success,
    ).toBe(true);
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

  it('rejects an unknown / typo key on a node — strict authored YAML (ADR-0023)', () => {
    expect(NodeSchema.safeParse({ id: 'in', type: 'input', extra: 1 }).success).toBe(false);
    expect(
      NodeSchema.safeParse({ id: 'a', type: 'agent', agent_ref: 'ag', temprature: 0.5 }).success,
    ).toBe(false);
  });

  it('rejects a non-finite / out-of-range agent-node temperature', () => {
    const node = { id: 'a', type: 'agent', agent_ref: 'ag' };
    expect(NodeSchema.safeParse({ ...node, temperature: Infinity }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...node, temperature: 3 }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...node, temperature: 0.5 }).success).toBe(true);
  });

  it('rejects the reserved timeout_action escalate (v1.0 allows only reject / approve)', () => {
    const gate = { id: 'g', type: 'human_gate', gate_type: 'approval' };
    expect(NodeSchema.safeParse({ ...gate, timeout_action: 'escalate' }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...gate, timeout_action: 'reject' }).success).toBe(true);
    expect(NodeSchema.safeParse({ ...gate, timeout_action: 'approve' }).success).toBe(true);
  });

  it('rejects the reserved expression_type jmespath / jsonlogic (v1.0 allows only js)', () => {
    const cond = {
      id: 'c',
      type: 'condition',
      expression: 'x > 1',
      branches: [{ when: true, target_node: 'a' }],
    };
    expect(NodeSchema.safeParse({ ...cond, expression_type: 'jmespath' }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...cond, expression_type: 'jsonlogic' }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...cond, expression_type: 'js' }).success).toBe(true);
  });

  it('accepts system_prompt_append + output_schema on an agent node, and output_schema on transform', () => {
    expect(
      NodeSchema.safeParse({
        id: 'a',
        type: 'agent',
        agent_ref: 'ag',
        system_prompt_append: 'Focus on auth issues.',
        output_schema: {
          type: 'object',
          required: ['score'],
          properties: { score: { type: 'number' } },
        },
      }).success,
    ).toBe(true);
    expect(
      NodeSchema.safeParse({
        id: 't',
        type: 'transform',
        transform: '{ x: 1 }',
        output_schema: { type: 'object' },
      }).success,
    ).toBe(true);
  });
});
