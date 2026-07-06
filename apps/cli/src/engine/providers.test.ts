import { parseWorkflow, type WorkflowDefinition } from '@relavium/core';
import type { ProviderRecord } from '@relavium/db';
import type { LlmProvider } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import {
  createProviderResolver,
  KNOWN_PROVIDERS,
  neededProviderIds,
  providerKeyEnvVar,
  validateProviderKey,
} from './providers.js';
import type { FetchLike } from './validated-fetch.js';

// A test key assembled at runtime (no contiguous secret literal — leakwatch).
const TEST_KEY = ['sk', 'prov', '90ABCDEF'].join('-');
// A REAL LlmProvider fixture (no double cast) — only `generate` is exercised; `stream` is a fail-loud stub.
const fakeProvider = (generate: LlmProvider['generate']): LlmProvider => ({
  id: 'anthropic',
  generate,
  stream: () => {
    throw new Error('stream is not exercised by validateProviderKey');
  },
  supports: CHAT_TEXT_CAPABILITY_FLAGS,
});

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
    const generate = vi
      .fn()
      .mockRejectedValue(new Error(`401 invalid_api_key: ${TEST_KEY} rejected`));
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

  it('passes an abort signal to the request (the internal bound)', async () => {
    const generate = vi.fn().mockResolvedValue({});
    await validateProviderKey(fakeProvider(generate), TEST_KEY, 'm-test');
    // The request carries the internal AbortController's signal (validateProviderKey always sets it).
    expect(generate.mock.calls[0]?.[0]).toHaveProperty('signal');
  });

  it('bounds a hanging request at the timeout (a stalled provider cannot hang the CLI)', async () => {
    const generate: LlmProvider['generate'] = () => new Promise(() => {}); // never resolves, ignores the signal
    const result = await validateProviderKey(fakeProvider(generate), TEST_KEY, 'm-test', 5);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timeout');
    expect(result.detail).not.toContain(TEST_KEY);
  });
});

describe('createProviderResolver custom endpoints (2.5.G S9 / ADR-0065 §3–4)', () => {
  /** A minimal provider registry row (only `name` + `baseUrl` matter to the custom-endpoint rebinding). */
  function row(name: string, baseUrl: string): ProviderRecord {
    return {
      id: `id-${name}`,
      name,
      displayName: name,
      baseUrl,
      defaultHeaders: {},
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  /** A fake validated fetch that records the request URLs + returns a valid OpenAI models-list payload. */
  function recordingFetch(): { fetch: FetchLike; urls: string[] } {
    const urls: string[] = [];
    const fetch: FetchLike = (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(
        new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.4-mini', object: 'model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    return { fetch, urls };
  }

  it('routes a CUSTOM openai-compatible base_url through the injected validated fetch', async () => {
    const { fetch, urls } = recordingFetch();
    const resolver = createProviderResolver({}, undefined, {
      providerStore: { list: () => [row('openai', 'https://my-proxy.example/v1')] },
      validatedFetch: fetch,
    });
    const openai = resolver.resolveProvider('openai');
    expect(openai?.listModels !== undefined).toBe(true); // the openai-compatible adapter carries the live-list capability
    // The listModels egress hits the CUSTOM endpoint (the dead-base_url bug is fixed) — via the validated fetch.
    await openai?.listModels?.('sk-test')?.catch(() => undefined); // the ROUTING is the assertion, not the parse result
    expect(urls.some((url) => url.startsWith('https://my-proxy.example/v1'))).toBe(true);
    expect(urls.every((url) => !url.startsWith('https://api.openai.com'))).toBe(true); // NOT the default endpoint
  });

  it('SKIPS a bad (private) custom base_url — the resolver still builds, keeping the default adapter (no crash)', () => {
    const { fetch } = recordingFetch();
    const resolver = createProviderResolver({}, undefined, {
      providerStore: { list: () => [row('openai', 'https://127.0.0.1/v1')] }, // fails the adapter's HTTPS+private gate
      validatedFetch: fetch,
    });
    expect(resolver.resolveProvider('openai')).toBeDefined(); // InvalidBaseUrlError caught; default adapter stands
  });

  it('SKIPS a custom base_url on anthropic/gemini (openai-compatible only this round) — no crash', () => {
    const { fetch } = recordingFetch();
    const resolver = createProviderResolver({}, undefined, {
      providerStore: {
        list: () => [row('anthropic', 'https://custom.example'), row('gemini', 'https://custom.example')],
      },
      validatedFetch: fetch,
    });
    expect(resolver.resolveProvider('anthropic')).toBeDefined();
    expect(resolver.resolveProvider('gemini')).toBeDefined();
  });

  it('leaves a DEFAULT base_url row alone — no custom adapter is built (the resolver builds cleanly)', () => {
    const { fetch } = recordingFetch();
    const resolver = createProviderResolver({}, undefined, {
      // The known default base_url is NOT custom ⇒ applyCustomEndpoints skips it, keeping the default adapter (no
      // injected validated fetch wired — proven by the positive routing test above, without a real network call).
      providerStore: { list: () => [row('openai', KNOWN_PROVIDERS.openai.baseUrl)] },
      validatedFetch: fetch,
    });
    expect(resolver.resolveProvider('openai')).toBeDefined();
  });
});
