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

  it('resolves a catalog-known id via the catalog branch (ADR-0071 hardening)', () => {
    // Every SHIPPED id ALSO matches a prefix, so the catalog and the heuristic agree — this cannot prove the catalog
    // is consulted FIRST, only that the catalog branch is wired and returns the right provider. The catalog-first
    // ORDER only bites for a live-only id the prefix cannot place (e.g. `chatgpt-4o-latest`), which no shipped
    // catalog id exercises; there the PERSISTED provider (see buildDefaultChatAgent) is the decisive fix.
    expect(inferProviderFromModel('gpt-5-chat-latest')).toBe('openai'); // a real catalog id
  });
});

describe('buildDefaultChatAgent', () => {
  it('builds a valid default agent over a known model, with the approved editing/search grant', () => {
    const agent = buildDefaultChatAgent(DEFAULT_CHAT_MODEL);
    expect(agent.id).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(agent.provider).toBe('anthropic');
    expect(agent.model).toBe(DEFAULT_CHAT_MODEL);
    expect(agent.system_prompt.length).toBeGreaterThan(0);
    expect(agent.tools).toEqual([...DEFAULT_CHAT_TOOLS]);
    expect(agent.tools).toEqual([
      'read_file',
      'list_directory',
      'git_status',
      'search_files',
      'find_files',
      'write_file',
      'edit_file',
      'run_command',
      'ask_user',
    ]);
    expect(agent.system_prompt).toContain('same turn');
    // ADR-0132: the prompt prefers the question tool only where it exists, and never promises it.
    expect(agent.system_prompt).toContain('use the ask_user tool if it is available');
    expect(agent.system_prompt).toContain(
      'otherwise ask a brief clarifying question in plain text',
    );
    expect(agent.system_prompt).toContain('In ask mode each write needs the user');
    expect(agent.system_prompt).toContain('plan mode is read-only');
    // ADR-0118: the prompt says what a command is and who decides it, and no longer claims there is no command execution.
    expect(agent.system_prompt).toContain('run_command');
    expect(agent.system_prompt).toContain('there is no shell');
    expect(agent.system_prompt).toContain('needs their approval');
    expect(agent.system_prompt).toContain('plan mode cannot run commands');
    expect(agent.system_prompt).not.toContain('no command execution');
    expect(agent.system_prompt).toContain('You have no network or ambient OS tools');
    // ADR-0118: a command is granted (every one is the person's decision); no commit / egress / ambient OS grant.
    for (const dangerous of [
      'git_commit',
      'http_request',
      'web_search',
      'mcp_call',
      'read_clipboard',
      'notify',
    ]) {
      expect(agent.tools).not.toContain(dangerous);
    }
  });

  it('respects a non-anthropic model by inferring its provider', () => {
    expect(buildDefaultChatAgent('gpt-4o').provider).toBe('openai');
    expect(buildDefaultChatAgent('gemini-2.5-pro').provider).toBe('gemini');
  });

  it('uses a persisted knownProvider VERBATIM, skipping inference — the Bug-3 fix (ADR-0059)', () => {
    // `chat-latest` is a live OpenAI id `keepOpenAiModelId` admits; it has no gpt/o-digit prefix and is not in the
    // catalog, so inference returns undefined and the chat used to crash "cannot infer a provider". A provider
    // persisted at pick time is used as-is, so the chat starts on the right provider.
    const agent = buildDefaultChatAgent('chat-latest', undefined, 'openai');
    expect(agent.provider).toBe('openai');
    expect(agent.model).toBe('chat-latest');
  });

  it('a knownProvider makes the throw path unreachable even for an id inference cannot place', () => {
    expect(buildDefaultChatAgent('mystery-model-9', undefined, 'anthropic').provider).toBe(
      'anthropic',
    );
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
