import { describe, expect, it } from 'vitest';

import { WorkflowSchema } from './workflow.js';

/**
 * The canonical reference workflow example, modeled on the "Complete example" in
 * docs/reference/contracts/workflow-yaml-spec.md (as the parsed object — YAML→object parsing is
 * `@relavium/core`'s responsibility). The structure mirrors the spec; the multi-line prompt strings
 * are **shortened paraphrases**, not verbatim transcriptions. It serves as a **round-trip anchor**:
 * the schema accepts it and a parse→serialize→re-parse cycle is stable (not a verbatim spec-drift anchor).
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

  it('accepts an agents entry that is a $ref to an external .agent.yaml (engine resolves it)', () => {
    expect(
      accepts(
        withWorkflow({
          agents: [...base.workflow.agents, { $ref: './reviewers/extra.agent.yaml' }],
        }),
      ),
    ).toBe(true);
  });

  it('rejects a malformed $ref agent entry (unknown key)', () => {
    expect(accepts(withWorkflow({ agents: [{ $ref: './x.agent.yaml', oops: 1 }] }))).toBe(false);
  });

  it('rejects a $ref agent entry with an empty path (caught at the schema, not at resolution)', () => {
    expect(accepts(withWorkflow({ agents: [{ $ref: '' }] }))).toBe(false);
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

  it('rejects a trigger type whose required payload is absent', () => {
    expect(accepts(withWorkflow({ trigger: { type: 'webhook' } }))).toBe(false);
    expect(accepts(withWorkflow({ trigger: { type: 'file_change' } }))).toBe(false);
    expect(accepts(withWorkflow({ trigger: { type: 'manual' } }))).toBe(true);
  });

  it('rejects duplicate input names', () => {
    expect(
      accepts(
        withWorkflow({
          inputs: [
            { name: 'x', type: 'string' },
            { name: 'x', type: 'number' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects duplicate context keys', () => {
    expect(
      accepts(
        withWorkflow({
          context: [
            { key: 'k', value: 'a' },
            { key: 'k', value: 'b' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects duplicate agent ids', () => {
    const agent = {
      id: 'dup',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'p',
    };
    expect(accepts(withWorkflow({ agents: [agent, { ...agent }] }))).toBe(false);
  });

  it('accepts a minimal workflow with only required fields', () => {
    // No version/name/tags/trigger/inputs/context/agents/tools — exercises the optional
    // paths and the `?? []` fallbacks in the uniqueness checks.
    expect(
      accepts({
        schema_version: '1.0',
        workflow: { id: 'min', nodes: [{ id: 'only', type: 'input' }], edges: [] },
      }),
    ).toBe(true);
  });

  it('strips the handle when checking fan-out vs parallel_of agreement', () => {
    // `fan-out:x` must resolve to the `fan-out` node before the parallel_of check;
    // `output` is not a branch, so it still rejects.
    expect(
      accepts(
        withWorkflow({ edges: [...base.workflow.edges, { from: 'fan-out:x', to: 'output' }] }),
      ),
    ).toBe(false);
  });

  it('rejects an unknown / typo key — strict authored YAML, not silent-strip (ADR-0023)', () => {
    // Unknown top-level key.
    expect(accepts({ ...base, surprise: 1 })).toBe(false);
    // Unknown key in the workflow body (e.g. a misspelled `triggers`).
    expect(accepts(withWorkflow({ triggers: {} }))).toBe(false);
    // Unknown key inside a node.
    expect(
      accepts(
        withWorkflow({
          nodes: base.workflow.nodes.map((n) => (n.id === 'input' ? { ...n, oops: 1 } : n)),
        }),
      ),
    ).toBe(false);
  });

  it('rejects a schedule trigger with an empty cron expression', () => {
    expect(accepts(withWorkflow({ trigger: { type: 'schedule', schedule: '' } }))).toBe(false);
    expect(accepts(withWorkflow({ trigger: { type: 'schedule', schedule: '0 9 * * 1' } }))).toBe(
      true,
    );
  });

  it('rejects a workflow with zero nodes', () => {
    expect(
      accepts({ schema_version: '1.0', workflow: { id: 'empty', nodes: [], edges: [] } }),
    ).toBe(false);
  });

  it('rejects an empty-string entry in a tool-policy allowlist', () => {
    expect(accepts(withWorkflow({ tools: { allowedCommands: [''] } }))).toBe(false);
    expect(accepts(withWorkflow({ tools: { allowedCommands: ['git status'] } }))).toBe(true);
  });

  it('accepts and round-trips workflow.metadata (the session-export transcript anchor, ADR-0026)', () => {
    const exported = withWorkflow({
      metadata: {
        source: 'agent-session',
        transcript: [
          { role: 'user', text: 'review this' },
          { role: 'assistant', text: 'done' },
        ],
      },
    });
    // metadata is a real schema field — it survives parse → serialize unchanged (unlike comments).
    expect(WorkflowSchema.parse(exported)).toEqual(exported);
  });

  it('accepts the resource-governance fields and rejects a bad/strict budget (ADR-0028)', () => {
    expect(
      accepts(
        withWorkflow({
          budget: { max_cost_microcents: 5000000, on_exceed: 'pause_for_approval' },
          timeout_ms: 300000,
          max_parallel: 4,
        }),
      ),
    ).toBe(true);
    expect(
      accepts(withWorkflow({ budget: { max_cost_microcents: 1, on_exceed: 'explode' } })),
    ).toBe(false);
    // budget is strict — an unknown key fails.
    expect(
      accepts(withWorkflow({ budget: { max_cost_microcents: 1, on_exceed: 'warn', oops: 1 } })),
    ).toBe(false);
    // a declared budget caps at a positive value — 0 is rejected (omit `budget` for no cap).
    expect(accepts(withWorkflow({ budget: { max_cost_microcents: 0, on_exceed: 'warn' } }))).toBe(
      false,
    );
  });

  it('accepts an opt-in allowedCommandGlobs in the tool policy (ADR-0029)', () => {
    expect(accepts(withWorkflow({ tools: { allowedCommandGlobs: ['npm run *'] } }))).toBe(true);
    expect(accepts(withWorkflow({ tools: { allowedCommandGlobs: [''] } }))).toBe(false);
  });

  it('accepts an input validation object and rejects an unknown validation key', () => {
    expect(
      accepts(
        withWorkflow({
          inputs: [
            {
              name: 'reviewer_email',
              type: 'string',
              validation: { format: 'email', max_length: 100 },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      accepts(
        withWorkflow({
          inputs: [{ name: 'sev', type: 'number', validation: { min: 0, max: 10, oops: 1 } }],
        }),
      ),
    ).toBe(false);
  });

  it('rejects contradictory validation bounds (min > max, min_length > max_length)', () => {
    expect(
      accepts(
        withWorkflow({
          inputs: [{ name: 'sev', type: 'number', validation: { min: 10, max: 5 } }],
        }),
      ),
    ).toBe(false);
    expect(
      accepts(
        withWorkflow({
          inputs: [{ name: 'n', type: 'string', validation: { min_length: 5, max_length: 2 } }],
        }),
      ),
    ).toBe(false);
  });

  it('rejects a validation key incompatible with the input type', () => {
    // a numeric `min` on a string, or a string-y `format` on a number, is an authored mistake
    expect(
      accepts(withWorkflow({ inputs: [{ name: 's', type: 'string', validation: { min: 0 } }] })),
    ).toBe(false);
    expect(
      accepts(
        withWorkflow({ inputs: [{ name: 'n', type: 'number', validation: { format: 'email' } }] }),
      ),
    ).toBe(false);
    // a *_length on a number is also wrong
    expect(
      accepts(
        withWorkflow({ inputs: [{ name: 'n', type: 'number', validation: { max_length: 5 } }] }),
      ),
    ).toBe(false);
  });

  it('rejects ANY validation key on a boolean input (its allowed set is empty)', () => {
    // `enum` looks semantically plausible on a boolean — exactly the realistic authored mistake.
    expect(
      accepts(
        withWorkflow({ inputs: [{ name: 'flag', type: 'boolean', validation: { enum: ['y'] } }] }),
      ),
    ).toBe(false);
    // an empty validation object carries no key, so there is nothing to reject
    expect(
      accepts(withWorkflow({ inputs: [{ name: 'flag', type: 'boolean', validation: {} }] })),
    ).toBe(true);
  });

  it('rejects numeric bound keys on code_diff / secret inputs (string-family keys only)', () => {
    expect(
      accepts(withWorkflow({ inputs: [{ name: 'd', type: 'code_diff', validation: { min: 0 } }] })),
    ).toBe(false);
    expect(
      accepts(withWorkflow({ inputs: [{ name: 's', type: 'secret', validation: { max: 9 } }] })),
    ).toBe(false);
  });

  it('does not crash when an invalid input type carries a validation object (clean reject)', () => {
    // The per-type key superRefine runs even though `type` failed its enum check — it must bail, not
    // throw on an undefined key list.
    expect(() =>
      accepts(withWorkflow({ inputs: [{ name: 'x', type: 'badtype', validation: { min: 0 } }] })),
    ).not.toThrow();
    expect(
      accepts(withWorkflow({ inputs: [{ name: 'x', type: 'badtype', validation: { min: 0 } }] })),
    ).toBe(false);
  });

  it('accepts type-appropriate validation keys', () => {
    expect(
      accepts(
        withWorkflow({
          inputs: [{ name: 's', type: 'string', validation: { pattern: '^a+$', max_length: 5 } }],
        }),
      ),
    ).toBe(true);
    expect(
      accepts(
        withWorkflow({ inputs: [{ name: 'n', type: 'number', validation: { min: 0, max: 9 } }] }),
      ),
    ).toBe(true);
  });
});
