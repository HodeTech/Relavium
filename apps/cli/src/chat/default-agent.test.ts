import { describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import {
  DEFAULT_CHAT_AGENT_ID,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_TOOLS,
  buildDefaultChatAgent,
  inferProviderFromModel,
} from './default-agent.js';

describe('inferProviderFromModel', () => {
  it('maps each seam provider from its well-known model prefix (case-insensitive)', () => {
    expect(inferProviderFromModel('claude-sonnet-4-6')).toBe('anthropic');
    expect(inferProviderFromModel('Claude-Opus-4-8')).toBe('anthropic');
    expect(inferProviderFromModel('gpt-4o')).toBe('openai');
    // The whole o-series resolves via /^o\d/ — o1/o3/o4 today and future o5+ without enumerating each.
    expect(inferProviderFromModel('o1-mini')).toBe('openai');
    expect(inferProviderFromModel('o3-mini')).toBe('openai');
    expect(inferProviderFromModel('o4-mini')).toBe('openai');
    expect(inferProviderFromModel('o4-mini-high')).toBe('openai');
    expect(inferProviderFromModel('gemini-2.5-pro')).toBe('gemini');
    expect(inferProviderFromModel('deepseek-chat')).toBe('deepseek');
  });

  it('returns undefined for an unrecognized model (the caller must fail loud, not guess)', () => {
    expect(inferProviderFromModel('mistral-large')).toBeUndefined();
    expect(inferProviderFromModel('llama-3')).toBeUndefined();
    expect(inferProviderFromModel('')).toBeUndefined();
  });
});

describe('buildDefaultChatAgent', () => {
  it('builds a valid default agent over a known model, with the read-only tool grant', () => {
    const agent = buildDefaultChatAgent(DEFAULT_CHAT_MODEL);
    expect(agent.id).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(agent.provider).toBe('anthropic');
    expect(agent.model).toBe(DEFAULT_CHAT_MODEL);
    expect(agent.system_prompt.length).toBeGreaterThan(0);
    expect(agent.tools).toEqual([...DEFAULT_CHAT_TOOLS]);
    // Secure-by-default: no write / exec / commit / egress tool in the default grant.
    for (const dangerous of [
      'write_file',
      'run_command',
      'git_commit',
      'http_request',
      'web_search',
      'mcp_call',
    ]) {
      expect(agent.tools).not.toContain(dangerous);
    }
  });

  it('respects a non-anthropic model by inferring its provider', () => {
    expect(buildDefaultChatAgent('gpt-4o').provider).toBe('openai');
    expect(buildDefaultChatAgent('gemini-2.5-pro').provider).toBe('gemini');
  });

  it('bakes the [chat].reasoning_effort default onto the agent, and OMITS it when absent (ADR-0066)', () => {
    expect(buildDefaultChatAgent('claude-opus-4-8', 'high').reasoning_effort).toBe('high');
    // Absent ⇒ the key is not present (never an explicit `undefined` under exactOptionalPropertyTypes).
    expect('reasoning_effort' in buildDefaultChatAgent('claude-opus-4-8')).toBe(false);
  });

  it('throws a clean exit-2 CliError when the provider cannot be inferred', () => {
    let caught: unknown;
    try {
      buildDefaultChatAgent('mystery-model-9');
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('mystery-model-9');
      expect(caught.message).toContain('--agent'); // guides the user to the explicit-agent escape hatch
    }
  });
});
