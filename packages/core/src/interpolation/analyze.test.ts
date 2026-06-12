import { describe, expect, it } from 'vitest';

import { WorkflowSchema } from '@relavium/shared';

import { WorkflowSecretLeakError, WorkflowValidationError } from '../errors.js';
import { parseWorkflow } from '../parser.js';

import { analyzePreRunReferences, analyzeSecretTaint } from './analyze.js';

/** A schema-valid inline agent the leak fixtures bind their agent nodes to. */
const AGENT = `  agents:
    - id: ag
      name: Ag
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: 'system'`;

/** Parse `yaml`, asserting it throws a WorkflowSecretLeakError; returns it for leak assertions. */
function expectLeak(yaml: string): WorkflowSecretLeakError {
  try {
    parseWorkflow(yaml);
  } catch (err) {
    if (!(err instanceof WorkflowSecretLeakError)) {
      throw err; // an unexpected error type — surface it rather than mis-narrowing
    }
    return err;
  }
  throw new Error('expected parseWorkflow to reject the secret interpolation');
}

describe('analyzeSecretTaint — rejected leaks (via parseWorkflow)', () => {
  it('rejects a secret-typed input interpolated directly into a prompt', () => {
    const err = expectLeak(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: api_key
      type: secret
${AGENT}
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: 'use {{inputs.api_key}}'
  edges: []`);
    expect(err.leaks[0]).toEqual({
      location: 'node `n`.prompt_template',
      secret: 'inputs.api_key',
    });
    expect(err.code).toBe('secret_interpolation');
  });

  it('rejects a secret laundered through a context entry (transitive taint, with `via`)', () => {
    const err = expectLeak(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: api_key
      type: secret
  context:
    - key: creds
      value: 'Bearer {{inputs.api_key}}'
${AGENT}
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: 'auth {{ctx.creds}}'
  edges: []`);
    expect(err.leaks[0]).toEqual({
      location: 'node `n`.prompt_template',
      secret: 'ctx.creds',
      via: 'inputs.api_key',
    });
    expect(err.message).toContain('inputs.api_key');
    expect(err.message).toContain('ADR-0029');
  });

  it('reaches taint through a two-hop, out-of-order context chain (fixpoint)', () => {
    const err = expectLeak(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: s
      type: secret
  context:
    - key: b
      value: '{{ctx.a}}'
    - key: a
      value: '{{inputs.s}}'
${AGENT}
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: '{{ctx.b}}'
  edges: []`);
    expect(err.leaks[0]).toEqual({
      location: 'node `n`.prompt_template',
      secret: 'ctx.b',
      via: 'ctx.a',
    });
  });

  it('rejects a `secrets.*` namespace reference used directly in human-gate text', () => {
    const err = expectLeak(`schema_version: '1.0'
workflow:
  id: w
  nodes:
    - id: g
      type: human_gate
      gate_type: review
      message_template: 'token {{secrets.token}}'
  edges: []`);
    expect(err.leaks[0]).toEqual({
      location: 'node `g`.message_template',
      secret: 'secrets.token',
    });
  });

  it('rejects a secret laundered through a non-secret input default (transitive via the default)', () => {
    // A `string` input whose default reads a secret resolves to the secret value at runtime, so a
    // prompt that reads that input would leak it — the taint must close over input defaults too.
    const err = expectLeak(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: api_key
      type: secret
    - name: reviewer
      type: string
      default: 'Bearer {{inputs.api_key}}'
${AGENT}
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: 'auth {{inputs.reviewer}}'
  edges: []`);
    expect(err.leaks[0]).toEqual({
      location: 'node `n`.prompt_template',
      secret: 'inputs.reviewer',
      via: 'inputs.api_key',
    });
  });

  it('rejects a secret in an inline agent `system_prompt` and a node `system_prompt_append`', () => {
    const err = expectLeak(`schema_version: '1.0'
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
      system_prompt: 'be terse {{inputs.api_key}}'
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      system_prompt_append: 'and {{inputs.api_key}}'
  edges: []`);
    const locations = err.leaks.map((leak) => leak.location);
    expect(locations).toContain('agent `ag`.system_prompt');
    expect(locations).toContain('node `n`.system_prompt_append');
  });

  it('reports every leaking site — two nodes referencing the same secret yield two leaks', () => {
    const err = expectLeak(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: api_key
      type: secret
${AGENT}
  nodes:
    - id: a
      type: agent
      agent_ref: ag
      prompt_template: 'one {{inputs.api_key}}'
    - id: b
      type: agent
      agent_ref: ag
      prompt_template: 'two {{inputs.api_key}}'
  edges: []`);
    expect(err.leaks).toHaveLength(2);
    expect(err.leaks.map((leak) => leak.location)).toEqual([
      'node `a`.prompt_template',
      'node `b`.prompt_template',
    ]);
  });
});

describe('analyzeSecretTaint — permitted (no leak)', () => {
  it('allows a secret to flow into a context entry that is never used in text', () => {
    // A secret may feed a credential/header path; it is only rejected when it reaches model/human text.
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: api_key
      type: secret
  context:
    - key: creds
      value: '{{inputs.api_key}}'
  nodes:
    - id: n
      type: input
  edges: []`);
    expect(analyzeSecretTaint(wf)).toEqual([]);
  });

  it('returns no leaks for the canonical (secret-free) pipeline', () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: file_path
      type: file_path
${AGENT}
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: 'review {{inputs.file_path}}'
  edges: []`);
    expect(analyzeSecretTaint(wf)).toEqual([]);
  });
});

describe('analyzePreRunReferences', () => {
  it('returns no issues for a clean context (reads inputs/ctx only)', () => {
    const wf = parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: p
      type: string
  context:
    - key: ok
      value: '{{inputs.p}}'
  nodes:
    - id: n
      type: input
  edges: []`);
    expect(analyzePreRunReferences(wf)).toEqual([]);
  });

  it('flags a context value that reads run.outputs (the positive branch, in isolation)', () => {
    // Built via the schema directly — parseWorkflow would reject this, so the analyzer is exercised
    // here on its own to pin the issue shape it produces.
    const wf = WorkflowSchema.parse({
      schema_version: '1.0',
      workflow: {
        id: 'w',
        context: [{ key: 'snapshot', value: '{{run.outputs["x"]}}' }],
        nodes: [{ id: 'x', type: 'input' }],
        edges: [],
      },
    });
    const issues = analyzePreRunReferences(wf);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('context `snapshot`.value');
    expect(issues[0]?.message).toContain('run.outputs');
  });

  it('flags an input default that reads run.outputs (defaults also resolve pre-run)', () => {
    // parseWorkflow rejects this with a WorkflowValidationError, consistent with the context gate.
    let thrown: unknown;
    try {
      parseWorkflow(`schema_version: '1.0'
workflow:
  id: w
  inputs:
    - name: seeded
      type: string
      default: 'from {{run.outputs["x"]}}'
  nodes:
    - id: x
      type: input
  edges: []`);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowValidationError);
    if (!(thrown instanceof WorkflowValidationError)) {
      throw new Error('expected a WorkflowValidationError');
    }
    expect(thrown.issues[0]?.field).toBe('input `seeded`.default');
    expect(thrown.issues[0]?.message).toContain('run.outputs');
  });
});
