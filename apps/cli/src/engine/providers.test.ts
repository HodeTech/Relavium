import { parseWorkflow } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { neededProviderIds, providerKeyEnvVar } from './providers.js';

/** Assemble a parsed workflow from an `agents:` block and the `nodes:` that reference them. */
function parse(agentsYaml: string, nodesYaml: string, edgesYaml: string) {
  return parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: provider-fixture
${agentsYaml}
  nodes:
${nodesYaml}
  edges:
${edgesYaml}`,
  );
}

const INPUT = '    - { id: start, type: input }';
const OUTPUT = '    - { id: out, type: output }';

describe('neededProviderIds', () => {
  it('returns the provider of an inline agent referenced by an agent node', () => {
    const def = parse(
      `  agents:
    - { id: scanner, model: claude-sonnet-4-6, provider: anthropic, system_prompt: inspect }`,
      `${INPUT}
    - { id: a, type: agent, agent_ref: scanner, prompt_template: 'go' }
${OUTPUT}`,
      `    - { from: start, to: a }
    - { from: a, to: out }`,
    );
    expect(neededProviderIds(def)).toEqual(['anthropic']);
  });

  it('excludes a fallback_chain provider (its key is conditional — surfaces at runtime)', () => {
    // `auth` is not retryable, so a missing PRIMARY key is fatal at attempt 1 and the chain never
    // fails over; a fallback key is only needed if the chain reaches it. Pre-flighting it would
    // false-fail a run whose primary succeeds, so only the primary provider is demanded.
    const def = parse(
      `  agents:
    - id: scanner
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: inspect
      fallback_chain:
        - { model: gpt-5.5, provider: openai, max_attempts: 2 }`,
      `${INPUT}
    - { id: a, type: agent, agent_ref: scanner, prompt_template: 'go' }
${OUTPUT}`,
      `    - { from: start, to: a }
    - { from: a, to: out }`,
    );
    expect(neededProviderIds(def)).toEqual(['anthropic']); // 'openai' (fallback) is NOT demanded
  });

  it('dedupes the primary provider across two agents that share it', () => {
    const def = parse(
      `  agents:
    - { id: a1, model: claude-opus-4-8, provider: anthropic, system_prompt: one }
    - { id: a2, model: claude-sonnet-4-6, provider: anthropic, system_prompt: two }`,
      `${INPUT}
    - { id: n1, type: agent, agent_ref: a1, prompt_template: 'go' }
    - { id: n2, type: agent, agent_ref: a2, prompt_template: 'go' }
${OUTPUT}`,
      `    - { from: start, to: n1 }
    - { from: n1, to: n2 }
    - { from: n2, to: out }`,
    );
    expect(neededProviderIds(def)).toEqual(['anthropic']);
  });

  it('counts only agents actually referenced by an agent node', () => {
    const def = parse(
      `  agents:
    - { id: used, model: claude-sonnet-4-6, provider: anthropic, system_prompt: inspect }
    - { id: unused, model: gemini-2.5-flash, provider: gemini, system_prompt: idle }`,
      `${INPUT}
    - { id: a, type: agent, agent_ref: used, prompt_template: 'go' }
${OUTPUT}`,
      `    - { from: start, to: a }
    - { from: a, to: out }`,
    );
    expect(neededProviderIds(def)).toEqual(['anthropic']); // 'gemini' (unused) is not demanded
  });

  it('skips an unresolved ($ref / registry) agent rather than false-failing', () => {
    // The node references an agent that is NOT an inline definition — the CLI cannot resolve external
    // .agent.yaml agents yet (2.M–2.Q), and parseWorkflow does not validate agent_ref resolution.
    const def = parse(
      `  agents:
    - { $ref: ./reviewers/external.agent.yaml }`,
      `${INPUT}
    - { id: a, type: agent, agent_ref: external, prompt_template: 'go' }
${OUTPUT}`,
      `    - { from: start, to: a }
    - { from: a, to: out }`,
    );
    expect(neededProviderIds(def)).toEqual([]); // skipped — its key surfaces at runtime, not pre-flight
  });

  it('returns no providers for a workflow with no agent nodes', () => {
    const def = parse(
      '',
      `${INPUT}
    - { id: t, type: transform, transform: '({ x: 1 })' }
${OUTPUT}`,
      `    - { from: start, to: t }
    - { from: t, to: out }`,
    );
    expect(neededProviderIds(def)).toEqual([]);
  });
});

describe('providerKeyEnvVar', () => {
  it('maps a lowercase provider id to its uppercase env var', () => {
    expect(providerKeyEnvVar('anthropic')).toBe('RELAVIUM_ANTHROPIC_API_KEY');
    expect(providerKeyEnvVar('deepseek')).toBe('RELAVIUM_DEEPSEEK_API_KEY');
  });
});
