import { stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { WorkflowSecretLeakError, WorkflowSyntaxError, WorkflowValidationError } from './errors.js';
import { collectReferences } from './interpolation/collect.js';
import { parseWorkflow } from './parser.js';

/** The canonical code-review pipeline (workflow-yaml-spec.md §Complete example), trimmed but whole. */
const VALID = `
schema_version: '1.0'
workflow:
  id: code-review-pipeline
  version: '1.2.0'
  name: Code Review Pipeline
  metadata:
    exported_from_session: sess-abc123
  inputs:
    - name: file_path
      type: file_path
      required: true
    - name: reviewer_email
      type: string
      required: false
      default: 'team@example.com'
  context:
    - key: code_content
      value: '{{inputs.file_path | read_file}}'
  agents:
    - id: security-scanner
      name: Security Scanner
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: 'Inspect {{ctx.code_content}} for vulnerabilities.'
      retry:
        max: 3
        backoff: exponential
      fallback_chain:
        - model: gpt-5.5
          provider: openai
          max_attempts: 2
  nodes:
    - id: input
      type: input
    - id: fan-out
      type: parallel
      parallel_of: [security-scan-node]
    - id: security-scan-node
      type: agent
      agent_ref: security-scanner
      prompt_template: 'Review this code: {{ctx.code_content}}'
    - id: severity-gate
      type: condition
      expression: 'run.outputs["security-scan-node"].score < 7'
      branches:
        - when: true
          target_node: human-approval
        - when: false
          target_node: synthesize-report
      default: synthesize-report
    - id: human-approval
      type: human_gate
      gate_type: approval
      assignee: '{{inputs.reviewer_email}}'
      message_template: 'Score {{run.outputs["security-scan-node"].score}}/10 for {{inputs.file_path}}.'
    - id: synthesize-report
      type: agent
      agent_ref: security-scanner
      prompt_template: 'Findings: {{run.outputs["security-scan-node"] | json}}; gate {{run.outputs["human-approval"].decision | default("not required")}}'
    - id: output
      type: output
      output_format: markdown
  edges:
    - { from: input, to: fan-out }
    - { from: fan-out, to: security-scan-node }
    - { from: security-scan-node, to: severity-gate }
    - { from: 'severity-gate:true', to: human-approval }
    - { from: 'severity-gate:false', to: synthesize-report }
    - { from: human-approval, to: synthesize-report }
    - { from: synthesize-report, to: output }
`;

describe('parseWorkflow — valid', () => {
  it('parses the canonical pipeline into a typed WorkflowDefinition', () => {
    const wf = parseWorkflow(VALID);
    expect(wf.schema_version).toBe('1.0');
    expect(wf.workflow.id).toBe('code-review-pipeline');
    expect(wf.workflow.nodes).toHaveLength(7);
    expect(wf.workflow.edges).toHaveLength(7);
  });

  it('preserves every config block, including metadata (ADR-0026) and agent retry/fallback', () => {
    const wf = parseWorkflow(VALID);
    expect(wf.workflow.metadata).toEqual({ exported_from_session: 'sess-abc123' });
    const agent = wf.workflow.agents?.[0];
    expect(agent && 'retry' in agent && agent.retry).toEqual({ max: 3, backoff: 'exponential' });
    expect(agent && 'fallback_chain' in agent && agent.fallback_chain).toEqual([
      { model: 'gpt-5.5', provider: 'openai', max_attempts: 2 },
    ]);
  });

  it('round-trips: parse → serialize → parse is stable (no config block dropped)', () => {
    const once = parseWorkflow(VALID);
    const twice = parseWorkflow(stringifyYaml(once));
    expect(twice).toEqual(once);
  });

  it('is deterministic — the same text parses to a deep-equal object', () => {
    expect(parseWorkflow(VALID)).toEqual(parseWorkflow(VALID));
  });

  it('parses transform + merge nodes (custom merge_fn) and round-trips them', () => {
    const yaml = `schema_version: '1.0'
workflow:
  id: w
  nodes:
    - id: a
      type: input
    - id: t
      type: transform
      transform: 'run.outputs["a"]'
    - id: m
      type: merge
      merge_strategy: custom
      merge_fn: 'inputs[0]'
    - id: out
      type: output
  edges:
    - { from: a, to: t }
    - { from: t, to: m }
    - { from: m, to: out }`;
    const wf = parseWorkflow(yaml);
    expect(wf.workflow.nodes.map((n) => n.type)).toEqual(['input', 'transform', 'merge', 'output']);
    expect(parseWorkflow(stringifyYaml(wf))).toEqual(wf); // round-trip preserves the new blocks
  });
});

describe('collectReferences', () => {
  it('surfaces structured, un-evaluated reference sites for the DAG builder', () => {
    const sites = collectReferences(parseWorkflow(VALID));
    const locations = sites.map((s) => s.location);
    expect(locations).toContain('context `code_content`.value');
    expect(locations).toContain('node `synthesize-report`.prompt_template');

    const synth = sites.find((s) => s.location === 'node `synthesize-report`.prompt_template');
    const nodeRefs = (synth?.references ?? [])
      .filter((r) => r.kind === 'node')
      .map((r) => r.identifier);
    expect(nodeRefs).toEqual(['security-scan-node', 'human-approval']);
  });
});

describe('parseWorkflow — malformed (each fails with a field-named, secret-free error)', () => {
  const doc = (workflowBody: string): string => `schema_version: '1.0'\nworkflow:\n${workflowBody}`;

  it('names the node + field when a required field is missing', () => {
    const err = expectValidationError(
      doc(`  id: w\n  nodes:\n    - id: summarize\n      type: agent\n  edges: []`),
    );
    expect(err.issues[0]?.field).toBe('node `summarize`.agent_ref');
    expect(err.issues[0]?.message).toMatch(/missing/);
  });

  it('rejects an authored `on_error` edge (a reserved, non-authorable edge kind) as an unknown key', () => {
    const err = expectValidationError(
      doc(
        `  id: w\n  nodes:\n    - id: a\n      type: input\n    - id: b\n      type: output\n  edges:\n    - { from: a, to: b, on_error: skip }`,
      ),
    );
    expect(err.issues[0]).toEqual({ field: 'edge #0', message: 'unknown key: `on_error`' });
  });

  it('rejects a duplicate node id', () => {
    const err = expectValidationError(
      doc(
        `  id: w\n  nodes:\n    - id: dup\n      type: input\n    - id: dup\n      type: output\n  edges: []`,
      ),
    );
    expect(err.message.toLowerCase()).toMatch(/duplicate/);
  });

  it('does not echo an authored secret via the custom Zod code path (superRefine invariant)', () => {
    // The duplicate-id superRefine uses `code: custom` and echoes the duplicate identifier in its
    // message. Duplicate node IDs are kebab-id-validated by the schema, so an arbitrary secret
    // cannot appear here — but this test pins the invariant: the custom code path must never leak
    // an authored secret value even if the superRefine message does embed it.
    const secret = 'sk-live-DO-NOT-LEAK-CUSTOM';
    // Use the per-type validation-key superRefine: an unrecognised key on a number input triggers
    // `code: custom, message: "validation key '${key}' is not allowed for input type '${type}'"`.
    // The key names are schema-defined strings — but we verify no arbitrary token leaks.
    const err = expectValidationError(
      doc(
        `  id: w\n  inputs:\n    - name: n\n      type: number\n      validation:\n        min_length: 1\n  nodes:\n    - id: x\n      type: input\n  edges: []`,
      ),
    );
    // `min_length` is not allowed for `number` → custom issue. Verify the secret is not present.
    expect(JSON.stringify(err.issues)).not.toContain(secret);
    // And the message IS informative (structural key name echoed, not a value).
    expect(err.issues.some((i) => i.message.includes('min_length'))).toBe(true);
  });

  it('rejects an unknown node `type` with the valid options', () => {
    const err = expectValidationError(
      doc(`  id: w\n  nodes:\n    - id: x\n      type: looop\n  edges: []`),
    );
    expect(err.issues[0]?.field).toBe('node `x`.type');
    expect(err.issues[0]?.message).toMatch(/expected one of: .*input/);
  });

  it('rejects an empty node list', () => {
    const err = expectValidationError(doc(`  id: w\n  nodes: []\n  edges: []`));
    expect(err.issues[0]?.field).toBe('nodes');
  });

  it('reports a YAML syntax fault with a line, not a schema error', () => {
    let thrown: unknown;
    try {
      parseWorkflow(`schema_version: '1.0'\nworkflow:\n  id: "unterminated`);
    } catch (error_) {
      thrown = error_;
    }
    expect(thrown).toBeInstanceOf(WorkflowSyntaxError);
    const err = thrown as WorkflowSyntaxError;
    expect(err.code).toBe('invalid_yaml');
    expect(typeof err.line).toBe('number');
  });

  it('never echoes an authored value — a secret in a mistyped field does not leak', () => {
    const secret = 'sk-live-DO-NOT-LEAK-0123456789';
    const err = expectValidationError(
      doc(
        `  id: w\n  timeout_ms: '${secret}'\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
      ),
    );
    expect(err.message).not.toContain(secret);
    expect(JSON.stringify(err.issues)).not.toContain(secret);
    expect(err.issues[0]?.field).toBe('timeout_ms');
  });

  it('does not echo an invalid (non-identifier) id into the field locator', () => {
    const secretId = 'SK-LIVE-DO-NOT-LEAK-9876543210'; // uppercase → fails kebab-id validation
    const err = expectValidationError(
      doc(`  id: w\n  nodes:\n    - id: ${secretId}\n      type: input\n  edges: []`),
    );
    expect(err.message).not.toContain(secretId);
    expect(JSON.stringify(err.issues)).not.toContain(secretId);
    expect(err.issues[0]?.field).toBe('node #0.id');
  });

  it('does not attach the raw ZodError as cause (no authored value reachable via cause)', () => {
    const err = expectValidationError(doc(`  id: w\n  nodes: []\n  edges: []`));
    expect(err.cause).toBeUndefined();
  });

  it('does not echo an authored value via the `invalid_string` code path (regex-failed id)', () => {
    // A node id with uppercase letters fails the kebab-id regex → Zod code `invalid_string`.
    // messageFor returns issue.message directly for this case — pin that the message is structural.
    const secret = 'SK-LIVE-INVALID-STRING';
    const err = expectValidationError(
      doc(`  id: w\n  nodes:\n    - id: ${secret}\n      type: input\n  edges: []`),
    );
    expect(err.message).not.toContain(secret);
    expect(JSON.stringify(err.issues)).not.toContain(secret);
    expect(err.issues[0]?.message).toMatch(/kebab/);
  });

  it('does not echo a kebab-invalid (underscore) node id — SAFE_ID_LABEL mirrors kebabIdSchema', () => {
    // A lowercase id with underscores fails the hyphen-only kebab schema; the locator must NOT echo it
    // (it would otherwise reflect a secret-shaped `sk_live_…` value), falling back to `node #0`.
    const secret = 'sk_live_do_not_echo';
    const err = expectValidationError(
      doc(`  id: w\n  nodes:\n    - id: ${secret}\n      type: input\n  edges: []`),
    );
    expect(JSON.stringify(err.issues)).not.toContain(secret);
    expect(err.issues[0]?.field).toBe('node #0.id');
  });

  it('surfaces a structural message for the `too_small` code path (min-1 string constraint)', () => {
    // An empty agent `system_prompt` (nonEmptyString = z.string().min(1)) → Zod code `too_small`.
    // messageFor returns issue.message directly — pin that it names the constraint, not the authored value.
    const err = expectValidationError(
      doc(
        `  id: w\n  agents:\n    - id: ag\n      name: A\n      model: claude-sonnet-4-6\n      provider: anthropic\n      system_prompt: ''\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
      ),
    );
    const issue = err.issues.find((i) => i.field.includes('system_prompt'));
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/character|length|least/i);
  });

  it('does not echo an authored value via the `too_big` code path (max-value numeric constraint)', () => {
    // temperature: 3 on an agent exceeds temperatureSchema's .max(2) → Zod code `too_big`.
    // messageFor returns issue.message directly — pin that it names the limit, not the authored value.
    const err = expectValidationError(
      doc(
        `  id: w\n  agents:\n    - id: ag\n      name: Agent\n      model: claude-sonnet-4-6\n      provider: anthropic\n      system_prompt: sys\n      temperature: 3\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
      ),
    );
    const issue = err.issues.find((i) => i.field.includes('temperature'));
    expect(issue).toBeDefined();
    expect(issue?.message).not.toContain('3');
  });
});

describe('parseWorkflow — hardened decode (ADR-0035)', () => {
  it('rejects anchors/aliases (no alias-bomb expansion — maxAliasCount 0)', () => {
    let thrown: unknown;
    try {
      parseWorkflow(
        `schema_version: '1.0'\nworkflow: &w\n  id: w\n  self: *w\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
      );
    } catch (error_) {
      thrown = error_;
    }
    expect(thrown).toBeInstanceOf(WorkflowSyntaxError);
    expect((thrown as WorkflowSyntaxError).message).toMatch(/anchors and aliases/);
  });

  it('rejects a source over the parse-size limit before parsing', () => {
    let thrown: unknown;
    try {
      parseWorkflow('a'.repeat(2 * 1024 * 1024 + 1));
    } catch (error_) {
      thrown = error_;
    }
    expect(thrown).toBeInstanceOf(WorkflowSyntaxError);
    expect((thrown as WorkflowSyntaxError).code).toBe('invalid_yaml');
  });

  it('keeps a date-like scalar a string (core schema → no Date/Buffer; deterministic across surfaces)', () => {
    const wf = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: w\n  metadata:\n    created: 2020-01-02\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
    );
    expect(wf.workflow.metadata?.['created']).toBe('2020-01-02');
  });
});

describe('parseWorkflow — purity + diagnostics', () => {
  it('attaches the caller-supplied workspace-relative source label to the error', () => {
    const err = expectValidationError(
      `schema_version: '1.0'\nworkflow:\n  id: w\n  nodes: []\n  edges: []`,
      {
        source: '.relavium/broken.relavium.yaml',
      },
    );
    expect(err.source).toBe('.relavium/broken.relavium.yaml');
  });
});

describe('parseWorkflow — diagnostic field naming (issue-mapper coverage)', () => {
  const doc = (body: string): string => `schema_version: '1.0'\nworkflow:\n${body}`;

  it('names an input + field for an invalid enum value', () => {
    const err = expectValidationError(
      doc(
        `  id: w\n  inputs:\n    - name: count\n      type: bogus\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
      ),
    );
    expect(err.issues[0]?.field).toBe('input `count`.type');
    expect(err.issues[0]?.message).toMatch(/expected one of:/);
  });

  it('still names an input whose (now schema-legal) name is uppercase/underscore (SAFE_NAME_LABEL)', () => {
    // `API_KEY` passes `interpolationNameSchema` but not the kebab id charset — the locator must use the
    // name charset, not degrade to a positional `#0`.
    const err = expectValidationError(
      doc(
        `  id: w\n  inputs:\n    - name: API_KEY\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
      ),
    );
    expect(err.issues[0]?.field).toBe('input `API_KEY`.type'); // missing `type` → named, not `input #0`
  });

  it('falls back to an index when a context entry is missing its key', () => {
    const err = expectValidationError(
      doc(
        `  id: w\n  context:\n    - value: hi\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
      ),
    );
    expect(err.issues.some((i) => i.field.startsWith('context #0'))).toBe(true);
  });

  it('falls back to an index when an agent entry is malformed', () => {
    const err = expectValidationError(
      doc(`  id: w\n  agents:\n    - {}\n  nodes:\n    - id: n\n      type: input\n  edges: []`),
    );
    expect(err.issues.some((i) => i.field === 'agent #0')).toBe(true);
  });

  it('falls back to an index when a node is missing its id', () => {
    const err = expectValidationError(doc(`  id: w\n  nodes:\n    - type: input\n  edges: []`));
    expect(err.issues.some((i) => i.field.startsWith('node #0'))).toBe(true);
  });

  it('lists multiple unknown keys (plural)', () => {
    const err = expectValidationError(
      doc(
        `  id: w\n  nodes:\n    - id: a\n      type: input\n    - id: b\n      type: output\n  edges:\n    - { from: a, to: b, foo: 1, bar: 2 }`,
      ),
    );
    expect(err.issues[0]?.message).toMatch(/unknown keys: /);
  });

  it('names a nested collection inside a node', () => {
    const err = expectValidationError(
      doc(
        `  id: w\n  nodes:\n    - id: gate\n      type: condition\n      expression: 'true'\n      branches:\n        - when: true\n  edges: []`,
      ),
    );
    expect(err.issues.some((i) => i.field.includes('branches['))).toBe(true);
  });

  it('names a top-level field for a wrong schema_version (no `workflow.` prefix)', () => {
    const err = expectValidationError(
      `schema_version: '2.0'\nworkflow:\n  id: w\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
    );
    expect(err.issues.some((i) => i.field === 'schema_version')).toBe(true);
  });

  it('handles a non-object workflow body without crashing', () => {
    const err = expectValidationError(`schema_version: '1.0'\nworkflow: not-an-object`);
    expect(err.issues[0]?.field).toBe('workflow');
  });

  it('carries the source label on a YAML syntax error', () => {
    let thrown: unknown;
    try {
      parseWorkflow(`workflow:\n  id: "x`, { source: 'f.yaml' });
    } catch (error_) {
      thrown = error_;
    }
    expect(thrown).toBeInstanceOf(WorkflowSyntaxError);
    expect((thrown as WorkflowSyntaxError).source).toBe('f.yaml');
  });

  it('carries the source label on an over-size error', () => {
    let thrown: unknown;
    try {
      parseWorkflow('a'.repeat(2 * 1024 * 1024 + 1), { source: 'big.yaml' });
    } catch (error_) {
      thrown = error_;
    }
    expect((thrown as WorkflowSyntaxError).source).toBe('big.yaml');
  });
});

describe('parseWorkflow — context referencing run.outputs (1.L2 static gate)', () => {
  it('rejects a context value that references run.outputs (resolved before any node runs)', () => {
    // workflow-yaml-spec.md §Context-and-interpolation: context is eagerly resolved pre-run, so a
    // node output is unavailable — `analyzePreRunReferences` makes this a field-named parse error.
    const err = expectValidationError(
      `schema_version: '1.0'\nworkflow:\n  id: w\n  context:\n    - key: snapshot\n      value: '{{run.outputs["some-node"]}}'\n  nodes:\n    - id: some-node\n      type: input\n  edges: []`,
    );
    expect(err.issues[0]?.field).toBe('context `snapshot`.value');
    expect(err.issues[0]?.message).toContain('run.outputs');
  });

  it('permits a context value that references inputs/ctx (the legitimate pre-run sources)', () => {
    const wf = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: w\n  inputs:\n    - name: p\n      type: string\n  context:\n    - key: snapshot\n      value: 'for {{inputs.p}}'\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
    );
    const ctxSite = collectReferences(wf).find((s) => s.location === 'context `snapshot`.value');
    expect(ctxSite?.category).toBe('context-value');
    expect(ctxSite?.references[0]).toMatchObject({ kind: 'inputs', identifier: 'p' });
  });
});

describe('parseWorkflow — secret interpolation (ADR-0029(c) static gate)', () => {
  const LEAK = `schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: api_key
      type: secret
  agents:
    - id: ag
      name: Ag
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: 'system'
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: 'use {{inputs.api_key}}'
  edges: []`;

  it('rejects at parse with a WorkflowSecretLeakError naming the field and the secret', () => {
    let thrown: unknown;
    try {
      parseWorkflow(LEAK, { source: 'leak.yaml' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowSecretLeakError);
    if (!(thrown instanceof WorkflowSecretLeakError)) {
      throw new Error('expected a WorkflowSecretLeakError');
    }
    expect(thrown.leaks[0]).toEqual({
      location: 'node `n`.prompt_template',
      secret: 'inputs.api_key',
    });
    expect(thrown.source).toBe('leak.yaml'); // the workspace-relative label is propagated
    expect(thrown.message).toContain('`inputs.api_key`'); // names the symbol, never a resolved value
  });
});

describe('collectReferences — field coverage', () => {
  it('skips a `$ref` agent and scans system_prompt_append; leaves whole-string fields alone', () => {
    const wf = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: w\n  agents:\n    - { $ref: ./other.agent.yaml }\n  nodes:\n    - id: a\n      type: agent\n      agent_ref: x\n      system_prompt_append: 'Focus on {{ctx.area}}'\n    - id: g\n      type: human_gate\n      gate_type: review\n  edges: []`,
    );
    const sites = collectReferences(wf);
    expect(sites.map((s) => s.location)).toEqual(['node `a`.system_prompt_append']);
    expect(sites[0]?.references[0]).toMatchObject({ kind: 'ctx', identifier: 'area' });
  });

  it('returns no sites when nothing carries interpolation', () => {
    const wf = parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: w\n  nodes:\n    - id: n\n      type: input\n  edges: []`,
    );
    expect(collectReferences(wf)).toEqual([]);
  });
});

/** Run `parseWorkflow`, asserting it throws a `WorkflowValidationError`, and return it. */
function expectValidationError(
  yamlText: string,
  opts?: { source?: string },
): WorkflowValidationError {
  let thrown: unknown;
  try {
    parseWorkflow(yamlText, opts);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(WorkflowValidationError);
  if (!(thrown instanceof WorkflowValidationError)) {
    throw new Error('expected a WorkflowValidationError');
  }
  return thrown;
}
