import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import type { LlmProvider } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import { neededProviderIds, providerKeyEnvVar, validateProviderKey } from './providers.js';

// A test key assembled at runtime (no contiguous secret literal — leakwatch).
const TEST_KEY = ['sk', 'prov', '90ABCDEF'].join('-');
const fakeProvider = (generate: LlmProvider['generate']): LlmProvider =>
  ({ generate }) as unknown as LlmProvider;

/** Assemble a parsed workflow from an `agents:` block and the `nodes:` that reference them. */
function parse(agentsYaml: string, nodesYaml: string, edgesYaml: string): WorkflowDefinition {
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

// The shared redaction seam (used by `provider test` AND the `/doctor --deep` probe) — its security contract is
// tested DIRECTLY here, not only through its two callers.
describe('validateProviderKey', () => {
  it('reports ok with the test model on a successful ping', async () => {
    const generate = vi.fn().mockResolvedValue({});
    const result = await validateProviderKey(fakeProvider(generate), TEST_KEY, 'm-test');
    expect(result).toEqual({ ok: true, detail: 'key works (m-test)' });
    expect(generate).toHaveBeenCalledWith(expect.anything(), TEST_KEY); // the key reached generate, not the detail
  });

  it('REDACTS the key from a failing-ping message (never the full key, keeps the last-4 hint)', async () => {
    const generate = vi.fn().mockRejectedValue(new Error(`401 invalid_api_key: ${TEST_KEY} rejected`));
    const result = await validateProviderKey(fakeProvider(generate), TEST_KEY, 'm-test');
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(TEST_KEY);
    expect(result.detail).toContain('90ABCDEF'.slice(-4)); // the keyHint last-4 survives
  });

  it('does not attach the error as a cause (no nested field a --verbose render could leak)', async () => {
    const generate = vi.fn().mockRejectedValue(new Error(`boom ${TEST_KEY}`));
    const result = await validateProviderKey(fakeProvider(generate), TEST_KEY, 'm-test');
    // The result is a plain value — there is no `cause`/`error` field carrying the raw key anywhere on it.
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('guards an empty key (the split("") footgun) without calling generate', async () => {
    const generate = vi.fn();
    const result = await validateProviderKey(fakeProvider(generate), '', 'm-test');
    expect(result).toEqual({ ok: false, detail: 'key test failed — (no key)' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('threads the abort signal into the request', async () => {
    const generate = vi.fn().mockResolvedValue({});
    const controller = new AbortController();
    await validateProviderKey(fakeProvider(generate), TEST_KEY, 'm-test', controller.signal);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ signal: controller.signal });
  });
});
