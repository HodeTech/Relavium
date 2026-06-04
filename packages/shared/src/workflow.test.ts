import { describe, expect, it } from 'vitest';

import { WorkflowSchema } from './workflow.js';

/**
 * The canonical reference workflow example, transcribed verbatim from the "Complete
 * example" in docs/reference/contracts/workflow-yaml-spec.md (as the parsed object —
 * YAML→object parsing is `@relavium/core`'s responsibility). This fixture is the
 * **no-drift anchor**: the schema must accept it and round-trip it unchanged.
 */
const codeReviewPipeline = {
  schema_version: '1.0',
  workflow: {
    id: 'code-review-pipeline',
    version: '1.2.0',
    name: 'Code Review Pipeline',
    description: 'Three-stage code review: security scan, style review, and human approval gate.\n',
    tags: ['engineering', 'review', 'security'],
    trigger: {
      type: 'file_change',
      file_change: { glob: 'src/**/*.ts', debounce_ms: 2000 },
    },
    inputs: [
      {
        name: 'file_path',
        type: 'file_path',
        required: true,
        description: 'Path to the TypeScript file to review',
      },
      {
        name: 'reviewer_email',
        type: 'string',
        required: false,
        default: 'team@example.com',
        description: 'Email to notify when human gate is reached',
      },
    ],
    context: [
      { key: 'focus_area', value: 'security vulnerabilities and type safety' },
      { key: 'code_content', value: '{{inputs.file_path | read_file}}' },
    ],
    agents: [
      {
        id: 'security-scanner',
        name: 'Security Scanner',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'You are a security-focused code reviewer. Return JSON.\n',
        temperature: 0.1,
        max_tokens: 1024,
        retry: { max: 3, backoff: 'exponential' },
        fallback_chain: [{ model: 'gpt-4o', provider: 'openai', max_attempts: 2 }],
      },
      {
        id: 'style-reviewer',
        name: 'Style Reviewer',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'You are a TypeScript style and architecture reviewer. Return JSON.\n',
        temperature: 0.2,
        max_tokens: 1024,
      },
      {
        id: 'report-synthesizer',
        name: 'Report Synthesizer',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'Combine the security scan and style review into one markdown report.\n',
        temperature: 0.3,
        max_tokens: 2048,
      },
    ],
    nodes: [
      { id: 'input', type: 'input' },
      { id: 'fan-out', type: 'parallel', parallel_of: ['security-scan-node', 'style-review-node'] },
      {
        id: 'security-scan-node',
        type: 'agent',
        agent_ref: 'security-scanner',
        prompt_template: 'Review this TypeScript file for security issues.\n',
        timeout_ms: 60000,
      },
      {
        id: 'style-review-node',
        type: 'agent',
        agent_ref: 'style-reviewer',
        prompt_template: 'Review this TypeScript file for style and architecture.\n',
        timeout_ms: 60000,
      },
      { id: 'merge', type: 'merge', merge_strategy: 'object_merge' },
      {
        id: 'severity-gate',
        type: 'condition',
        expression: 'run.outputs["security-scan-node"].score < 7',
        branches: [
          { when: true, target_node: 'human-approval' },
          { when: false, target_node: 'synthesize-report' },
        ],
        default: 'synthesize-report',
      },
      {
        id: 'human-approval',
        type: 'human_gate',
        gate_type: 'approval',
        assignee: '{{inputs.reviewer_email}}',
        message_template: 'Security scan flagged issues. Approve to continue.\n',
        timeout_ms: 86400000,
        timeout_action: 'reject',
      },
      {
        id: 'synthesize-report',
        type: 'agent',
        agent_ref: 'report-synthesizer',
        prompt_template: 'Security results and style results follow.\n',
        timeout_ms: 45000,
      },
      { id: 'output', type: 'output', output_format: 'markdown' },
    ],
    edges: [
      { from: 'input', to: 'fan-out' },
      { from: 'fan-out', to: 'security-scan-node' },
      { from: 'fan-out', to: 'style-review-node' },
      { from: 'security-scan-node', to: 'merge' },
      { from: 'style-review-node', to: 'merge' },
      { from: 'merge', to: 'severity-gate' },
      { from: 'severity-gate:true', to: 'human-approval' },
      { from: 'severity-gate:false', to: 'synthesize-report' },
      { from: 'human-approval', to: 'synthesize-report' },
      { from: 'synthesize-report', to: 'output' },
    ],
  },
};

const base = codeReviewPipeline;
/** Build an invalid/variant doc (typed `unknown`, fed to `safeParse`). */
const withWorkflow = (over: Record<string, unknown>): unknown => ({
  ...base,
  workflow: { ...base.workflow, ...over },
});
const accepts = (doc: unknown): boolean => WorkflowSchema.safeParse(doc).success;

describe('WorkflowSchema', () => {
  it('accepts the canonical reference example', () => {
    expect(() => WorkflowSchema.parse(codeReviewPipeline)).not.toThrow();
  });

  it('round-trips the reference example with no drift', () => {
    const once = WorkflowSchema.parse(codeReviewPipeline);
    // No fields stripped or injected: the parsed output equals the source object.
    expect(once).toEqual(codeReviewPipeline);
    // Idempotent through a serialize → re-parse cycle.
    const twice = WorkflowSchema.parse(JSON.parse(JSON.stringify(once)) as unknown);
    expect(twice).toEqual(once);
  });

  it('rejects a missing schema_version', () => {
    expect(accepts({ workflow: base.workflow })).toBe(false);
  });

  it('rejects an unknown schema_version (the literal is the migration anchor)', () => {
    expect(accepts({ ...base, schema_version: '2.0' })).toBe(false);
  });

  it('rejects an unknown node type', () => {
    expect(
      accepts(
        withWorkflow({ nodes: [...base.workflow.nodes, { id: 'mystery', type: 'frobnicate' }] }),
      ),
    ).toBe(false);
  });

  it('rejects duplicate node ids', () => {
    expect(
      accepts(withWorkflow({ nodes: [...base.workflow.nodes, { id: 'output', type: 'output' }] })),
    ).toBe(false);
  });

  it('rejects a merge node with merge_strategy=custom but no merge_fn', () => {
    const nodes = base.workflow.nodes.map((n) =>
      n.id === 'merge' ? { ...n, merge_strategy: 'custom' } : n,
    );
    expect(accepts(withWorkflow({ nodes }))).toBe(false);
  });

  it('accepts a custom merge when merge_fn is provided', () => {
    const nodes = base.workflow.nodes.map((n) =>
      n.id === 'merge' ? { ...n, merge_strategy: 'custom', merge_fn: '{ ...a, ...b }' } : n,
    );
    expect(accepts(withWorkflow({ nodes }))).toBe(true);
  });

  it('rejects a non-kebab-case workflow id', () => {
    expect(accepts(withWorkflow({ id: 'Code_Review_Pipeline' }))).toBe(false);
  });

  it('rejects an unknown trigger type', () => {
    expect(accepts(withWorkflow({ trigger: { type: 'cron' } }))).toBe(false);
  });

  it('rejects a webhook trigger missing its required sub-fields', () => {
    expect(accepts(withWorkflow({ trigger: { type: 'webhook', webhook: { path: '/x' } } }))).toBe(
      false,
    );
    expect(
      accepts(
        withWorkflow({ trigger: { type: 'webhook', webhook: { path: '/x', secret_env: 'S' } } }),
      ),
    ).toBe(true);
  });

  it('rejects an unknown input type', () => {
    expect(accepts(withWorkflow({ inputs: [{ name: 'when', type: 'datetime' }] }))).toBe(false);
  });

  it('rejects an explicit fan-out edge that contradicts parallel_of', () => {
    // `output` is not in the fan-out node's parallel_of.
    expect(
      accepts(withWorkflow({ edges: [...base.workflow.edges, { from: 'fan-out', to: 'output' }] })),
    ).toBe(false);
  });
});
