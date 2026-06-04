import { describe, expect, it } from 'vitest';

import * as shared from './index.js';

describe('@relavium/shared public surface', () => {
  it('exports the canonical constants', () => {
    expect(shared.SCHEMA_VERSION).toBe('1.0');
    expect(shared.RUN_EVENT_TYPES).toContain('cost:updated');
    expect(shared.WORKFLOW_NODE_TYPES).toContain('human_gate');
    expect(shared.LLM_PROVIDERS).toEqual(['anthropic', 'openai', 'gemini', 'deepseek']);
    expect(shared.EXECUTION_MODES).toEqual(['local', 'cloud', 'managed']);
  });

  it('exports the full canonical schema set', () => {
    const names = [
      'WorkflowSchema',
      'AgentSchema',
      'NodeSchema',
      'EdgeSchema',
      'RunEventSchema',
      'CostUpdatedEventSchema',
      'GateDecisionSchema',
      'RunSchema',
      'GlobalConfigSchema',
      'ProjectConfigSchema',
    ] as const;
    for (const name of names) {
      expect(shared[name]).toBeDefined();
    }
  });

  it('does not leak internal primitives from common.ts', () => {
    const exported = Object.keys(shared);
    for (const internal of ['kebabIdSchema', 'nonEmptyString', 'positiveInt', 'nonNegativeInt']) {
      expect(exported).not.toContain(internal);
    }
  });
});
