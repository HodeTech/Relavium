import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentParseError } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { DEFAULT_CHAT_AGENT_ID, DEFAULT_CHAT_MODEL } from './default-agent.js';
import { resolveChatAgent } from './agent-source.js';

const AGENT_YAML = [
  'id: coder',
  'provider: anthropic',
  'model: claude-sonnet-4-6',
  'system_prompt: You are a focused coding assistant.',
].join('\n');

describe('resolveChatAgent', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-chat-agent-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds the built-in default agent over [chat].default_model when no --agent is given', () => {
    const agent = resolveChatAgent(undefined, {
      cwd: dir,
      projectConfigDir: undefined,
      defaultModel: 'gpt-4o',
    });
    expect(agent.id).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(agent.model).toBe('gpt-4o');
    expect(agent.provider).toBe('openai');
  });

  it('falls back to DEFAULT_CHAT_MODEL when neither --agent nor [chat].default_model is set', () => {
    const agent = resolveChatAgent(undefined, {
      cwd: dir,
      projectConfigDir: undefined,
      defaultModel: undefined,
    });
    expect(agent.model).toBe(DEFAULT_CHAT_MODEL);
  });

  it('resolves an explicit --agent path through the strict core parseAgent', () => {
    const path = join(dir, 'coder.agent.yaml');
    writeFileSync(path, AGENT_YAML);
    const agent = resolveChatAgent(path, {
      cwd: dir,
      projectConfigDir: undefined,
      defaultModel: undefined,
    });
    expect(agent.id).toBe('coder');
    expect(agent.provider).toBe('anthropic');
  });

  it('discovers a bare --agent id under <projectConfigDir>/agents/ (.agent.yaml suffix)', () => {
    const projectConfigDir = join(dir, '.relavium');
    mkdirSync(join(projectConfigDir, 'agents'), { recursive: true });
    writeFileSync(join(projectConfigDir, 'agents', 'coder.agent.yaml'), AGENT_YAML);
    const agent = resolveChatAgent('coder', {
      cwd: dir,
      projectConfigDir,
      defaultModel: undefined,
    });
    expect(agent.id).toBe('coder');
  });

  it('discovers a bare --agent id via the fallback suffixes (.relavium.yaml when no .agent.yaml)', () => {
    const projectConfigDir = join(dir, '.relavium');
    mkdirSync(join(projectConfigDir, 'agents'), { recursive: true });
    // Only the .relavium.yaml exists — the resolver must try it after .agent.yaml misses.
    writeFileSync(join(projectConfigDir, 'agents', 'coder.relavium.yaml'), AGENT_YAML);
    const agent = resolveChatAgent('coder', {
      cwd: dir,
      projectConfigDir,
      defaultModel: undefined,
    });
    expect(agent.id).toBe('coder');
  });

  it('discovers a bare --agent id via the bare .yaml suffix (last in the fallback chain)', () => {
    const projectConfigDir = join(dir, '.relavium');
    mkdirSync(join(projectConfigDir, 'agents'), { recursive: true });
    // Neither .agent.yaml nor .relavium.yaml exists — only coder.yaml, the third/last idSuffix.
    writeFileSync(join(projectConfigDir, 'agents', 'coder.yaml'), AGENT_YAML);
    const agent = resolveChatAgent('coder', {
      cwd: dir,
      projectConfigDir,
      defaultModel: undefined,
    });
    expect(agent.id).toBe('coder');
  });

  it('is a clean exit-2 CliError when the --agent ref is not found', () => {
    let caught: unknown;
    try {
      resolveChatAgent('nope', {
        cwd: dir,
        projectConfigDir: join(dir, '.relavium'),
        defaultModel: undefined,
      });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('agent');
    }
  });

  it('reports a clean "no project" miss for a bare id when there is no .relavium/ project dir', () => {
    let caught: unknown;
    try {
      resolveChatAgent('some-agent', {
        cwd: dir,
        projectConfigDir: undefined,
        defaultModel: undefined,
      });
    } catch (err) {
      caught = err;
    }
    // A bare id with no project dir has no candidate paths — a clean exit-2, not a crash.
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('no project');
    }
  });

  it('surfaces an invalid .agent.yaml as a field-named AgentParseError (not a silent default or CliError)', () => {
    const path = join(dir, 'bad.agent.yaml');
    writeFileSync(path, 'id: bad\nprovider: not-a-provider\nmodel: m\nsystem_prompt: x');
    let caught: unknown;
    try {
      resolveChatAgent(path, { cwd: dir, projectConfigDir: undefined, defaultModel: undefined });
    } catch (err) {
      caught = err;
    }
    // A schema failure is a typed parse error naming the offending field — NOT an invocation CliError.
    expect(caught).toBeInstanceOf(AgentParseError);
    expect(isCliError(caught)).toBe(false);
    if (caught instanceof AgentParseError) {
      expect(caught.message).toMatch(/provider/i); // names the offending field, secret-free
    }
  });
});
