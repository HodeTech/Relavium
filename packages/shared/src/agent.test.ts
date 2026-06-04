import { describe, expect, it } from 'vitest';

import { AgentSchema } from './agent.js';

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
});
