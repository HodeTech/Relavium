import { describe, expect, it } from 'vitest';

import { AgentSchema, McpServerRefSchema, MemorySchema } from './agent.js';

/** The reference agent example from docs/reference/contracts/agent-yaml-spec.md. */
const summarizer = {
  id: 'summarizer',
  name: 'Summarizer Agent',
  description: 'Produces a concise 3-bullet summary focused on a context-supplied area.',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  system_prompt: 'You are a concise summarizer. Summarize the input in 3 bullet points.\n',
  temperature: 0.3,
  max_tokens: 512,
  tools: [],
  retry: { max: 3, backoff: 'exponential' },
  fallback_chain: [
    { model: 'gpt-4o', provider: 'openai', max_attempts: 2 },
    { model: 'gemini-2.5-pro', provider: 'gemini', max_attempts: 1 },
  ],
};

describe('AgentSchema', () => {
  it('accepts and round-trips the reference agent with no drift', () => {
    const once = AgentSchema.parse(summarizer);
    expect(once).toEqual(summarizer);
  });

  it('rejects a missing model', () => {
    expect(AgentSchema.safeParse({ ...summarizer, model: undefined }).success).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(AgentSchema.safeParse({ ...summarizer, provider: 'cohere' }).success).toBe(false);
  });

  it('rejects a fallback entry with a non-positive max_attempts', () => {
    expect(
      AgentSchema.safeParse({
        ...summarizer,
        fallback_chain: [{ model: 'gpt-4o', provider: 'openai', max_attempts: 0 }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty system_prompt', () => {
    expect(AgentSchema.safeParse({ ...summarizer, system_prompt: '' }).success).toBe(false);
  });

  it('rejects duplicate mcp_servers ids within an agent', () => {
    const server = { id: 'gh', transport: 'stdio', command: 'npx' };
    expect(
      AgentSchema.safeParse({ ...summarizer, mcp_servers: [server, { ...server }] }).success,
    ).toBe(false);
  });

  it('accepts a minimal agent with only the required fields', () => {
    expect(
      AgentSchema.safeParse({
        id: 'minimal',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        system_prompt: 'Be helpful.',
      }).success,
    ).toBe(true);
  });

  it('accepts optional fields independently present', () => {
    const min = { id: 'a', model: 'm', provider: 'anthropic', system_prompt: 'p' };
    expect(AgentSchema.safeParse({ ...min, temperature: 0.7 }).success).toBe(true);
    expect(
      AgentSchema.safeParse({ ...min, memory: { type: 'window', window_size: 5 } }).success,
    ).toBe(true);
    expect(AgentSchema.safeParse({ ...min, retry: { max: 2, backoff: 'linear' } }).success).toBe(
      true,
    );
  });

  it('accepts optional input_schema / output_schema (agent-yaml-spec.md)', () => {
    const min = { id: 'a', model: 'm', provider: 'anthropic', system_prompt: 'p' };
    expect(
      AgentSchema.safeParse({
        ...min,
        input_schema: { type: 'object', properties: { text: { type: 'string' } } },
        output_schema: { type: 'object' },
      }).success,
    ).toBe(true);
  });

  it('rejects non-object input_schema / output_schema metadata (but not an unknown inner JSON-Schema type)', () => {
    const min = { id: 'a', model: 'm', provider: 'anthropic', system_prompt: 'p' };
    // The metadata is a JSON-Schema-subset bag — `jsonSchemaMetadataSchema = z.record(string, unknown)`
    // (common.ts): a NON-OBJECT value is rejected...
    expect(AgentSchema.safeParse({ ...min, input_schema: 'not-an-object' }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...min, output_schema: 42 }).success).toBe(false);
    // ...but the bag intentionally does NOT deep-validate the inner JSON Schema, so an unknown inner
    // `type` is accepted (the engine/consumer validates the schema body, not the authored-shape layer).
    expect(
      AgentSchema.safeParse({ ...min, input_schema: { type: 'invalid_json_schema_type' } }).success,
    ).toBe(true);
  });

  it('accepts zero or one mcp_servers (uniqueness boundary)', () => {
    const min = { id: 'a', model: 'm', provider: 'anthropic', system_prompt: 'p' };
    expect(AgentSchema.safeParse({ ...min, mcp_servers: [] }).success).toBe(true);
    expect(
      AgentSchema.safeParse({
        ...min,
        mcp_servers: [{ id: 'one', transport: 'stdio', command: 'npx' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown / typo key — strict authored YAML (ADR-0023)', () => {
    // `temprature` is a typo for `temperature`; strict rejects it instead of dropping it.
    expect(AgentSchema.safeParse({ ...summarizer, temprature: 0.3 }).success).toBe(false);
  });

  it('rejects a non-finite or out-of-range temperature', () => {
    // provider: 'openai' genuinely supports the full [0, 2] envelope (Anthropic caps at 1;
    // that provider-specific limit is the adapter's job, not the schema's).
    const min = { id: 'a', model: 'm', provider: 'openai', system_prompt: 'p' };
    expect(AgentSchema.safeParse({ ...min, temperature: Infinity }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...min, temperature: Number.NaN }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...min, temperature: -0.1 }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...min, temperature: 2.5 }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...min, temperature: 0 }).success).toBe(true);
    expect(AgentSchema.safeParse({ ...min, temperature: 2 }).success).toBe(true);
  });
});

describe('MemorySchema', () => {
  it('accepts none and summary without a window_size', () => {
    expect(MemorySchema.safeParse({ type: 'none' }).success).toBe(true);
    expect(MemorySchema.safeParse({ type: 'summary' }).success).toBe(true);
  });

  it('requires window_size only when type is window', () => {
    expect(MemorySchema.safeParse({ type: 'window', window_size: 10 }).success).toBe(true);
    expect(MemorySchema.safeParse({ type: 'window' }).success).toBe(false);
    expect(MemorySchema.safeParse({ type: 'window', window_size: 0 }).success).toBe(false);
  });

  it('rejects an unknown memory type', () => {
    expect(MemorySchema.safeParse({ type: 'episodic' }).success).toBe(false);
  });
});

describe('McpServerRefSchema', () => {
  it('requires command for stdio transport', () => {
    expect(
      McpServerRefSchema.safeParse({ id: 'github', transport: 'stdio', command: 'npx' }).success,
    ).toBe(true);
    expect(McpServerRefSchema.safeParse({ id: 'github', transport: 'stdio' }).success).toBe(false);
  });

  it('rejects a stray url on a stdio transport (a mis-declared server fails at parse)', () => {
    expect(
      McpServerRefSchema.safeParse({
        id: 'github',
        transport: 'stdio',
        command: 'npx',
        url: 'https://host/mcp',
      }).success,
    ).toBe(false);
  });

  it('requires url for sse / websocket transports', () => {
    expect(
      McpServerRefSchema.safeParse({
        id: 'docs',
        transport: 'sse',
        url: 'http://localhost:4000/mcp',
      }).success,
    ).toBe(true);
    expect(McpServerRefSchema.safeParse({ id: 'docs', transport: 'sse' }).success).toBe(false);
    expect(McpServerRefSchema.safeParse({ id: 'docs', transport: 'websocket' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown transport', () => {
    expect(
      McpServerRefSchema.safeParse({ id: 'x', transport: 'grpc', url: 'http://x' }).success,
    ).toBe(false);
  });

  it('rejects a malformed url', () => {
    expect(
      McpServerRefSchema.safeParse({ id: 'd', transport: 'sse', url: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('rejects an unsafe url scheme (SSRF guard — file:/javascript: etc.)', () => {
    expect(
      McpServerRefSchema.safeParse({ id: 'x', transport: 'sse', url: 'file:///etc/passwd' })
        .success,
    ).toBe(false);
    expect(
      McpServerRefSchema.safeParse({ id: 'x', transport: 'websocket', url: 'wss://host/mcp' })
        .success,
    ).toBe(true);
  });

  it('rejects a url scheme that mismatches the transport', () => {
    // websocket must be ws(s), not http(s); sse must be http(s), not ws(s).
    expect(
      McpServerRefSchema.safeParse({ id: 'x', transport: 'websocket', url: 'https://host/mcp' })
        .success,
    ).toBe(false);
    expect(
      McpServerRefSchema.safeParse({ id: 'x', transport: 'sse', url: 'wss://host/mcp' }).success,
    ).toBe(false);
  });

  it('rejects a url that embeds credentials (secret hygiene)', () => {
    expect(
      McpServerRefSchema.safeParse({
        id: 'x',
        transport: 'sse',
        url: 'https://user:pass@host/mcp',
      }).success,
    ).toBe(false);
  });

  it('accepts the reconciled `http` (Streamable HTTP) transport with an http(s) url (ADR-0052 §5)', () => {
    expect(
      McpServerRefSchema.safeParse({ id: 'docs', transport: 'http', url: 'https://host/mcp' })
        .success,
    ).toBe(true);
    expect(McpServerRefSchema.safeParse({ id: 'docs', transport: 'http' }).success).toBe(false); // needs url
    expect(
      McpServerRefSchema.safeParse({ id: 'docs', transport: 'http', url: 'wss://host/mcp' })
        .success,
    ).toBe(false); // http → http(s), not ws(s)
  });

  describe('by-name `ref` form (ADR-0052 §5)', () => {
    it('accepts a bare { ref } and { ref, tools_allowlist } (the registration provides the connection)', () => {
      expect(McpServerRefSchema.safeParse({ ref: 'github' }).success).toBe(true);
      expect(
        McpServerRefSchema.safeParse({ ref: 'github', tools_allowlist: ['create_issue'] }).success,
      ).toBe(true);
    });

    it('rejects a `ref` mixed with ANY inline connection field (mutual exclusivity)', () => {
      for (const inline of [
        { id: 'gh' },
        { transport: 'stdio' as const },
        { command: 'npx' },
        { args: ['-y', 'pkg'] },
        { env: { TOKEN: 'x' } },
        { url: 'https://h/mcp' },
      ]) {
        expect(McpServerRefSchema.safeParse({ ref: 'github', ...inline }).success).toBe(false);
      }
    });

    it('rejects an inline entry missing id or transport (a ref is the only way to omit them)', () => {
      expect(McpServerRefSchema.safeParse({ transport: 'stdio', command: 'npx' }).success).toBe(
        false,
      ); // no id
      expect(McpServerRefSchema.safeParse({ id: 'gh', command: 'npx' }).success).toBe(false); // no transport
      expect(McpServerRefSchema.safeParse({}).success).toBe(false); // neither inline nor ref
    });
  });
});
