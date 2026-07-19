import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentParseError, MAX_SOURCE_CHARS } from '@relavium/core';
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

  it('passes opts.defaultProvider VERBATIM to the default agent — an unplaceable id starts (ADR-0059, Bug-3 wiring)', () => {
    // The decisive Bug-3 hop: a persisted provider carried into the default agent so a live-discovered id the prefix
    // map cannot place (`chat-latest`) still resolves. Without this passthrough it throws "cannot infer a provider".
    const agent = resolveChatAgent(undefined, {
      cwd: dir,
      projectConfigDir: undefined,
      defaultModel: 'chat-latest',
      defaultProvider: 'openai',
    });
    expect(agent.model).toBe('chat-latest');
    expect(agent.provider).toBe('openai');
  });

  it('still throws a clean CliError for an unplaceable id when NO defaultProvider is persisted', () => {
    let caught: unknown;
    try {
      resolveChatAgent(undefined, {
        cwd: dir,
        projectConfigDir: undefined,
        defaultModel: 'chat-latest',
      });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
  });

  it('falls back to DEFAULT_CHAT_MODEL when neither --agent nor [chat].default_model is set', () => {
    const agent = resolveChatAgent(undefined, {
      cwd: dir,
      projectConfigDir: undefined,
      defaultModel: undefined,
    });
    expect(agent.model).toBe(DEFAULT_CHAT_MODEL);
  });

  it('bakes opts.reasoningEffort onto the DEFAULT agent (ADR-0066)', () => {
    const agent = resolveChatAgent(undefined, {
      cwd: dir,
      projectConfigDir: undefined,
      defaultModel: 'claude-opus-4-8',
      reasoningEffort: 'high',
    });
    expect(agent.id).toBe(DEFAULT_CHAT_AGENT_ID);
    expect(agent.reasoning_effort).toBe('high');
  });

  it('does NOT leak [chat].reasoning_effort into an explicit --agent — the authored tier wins (ADR-0066 §5)', () => {
    const path = join(dir, 'coder.agent.yaml');
    writeFileSync(path, `${AGENT_YAML}\nreasoning_effort: off`); // the authored agent pins 'off'
    const agent = resolveChatAgent(path, {
      cwd: dir,
      projectConfigDir: undefined,
      defaultModel: undefined,
      reasoningEffort: 'high', // a config default MUST NOT override the authored agent's own tier
    });
    expect(agent.id).toBe('coder');
    expect(agent.reasoning_effort).toBe('off'); // the authored 'off' survives — config did not leak in
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

  // A bare `--agent id` is discovered under `<projectConfigDir>/agents/` by trying the idSuffix chain in order:
  // `.agent.yaml` → `.relavium.yaml` → `.yaml`. One case per suffix, each proving that suffix ALONE resolves.
  it.each([
    { label: '.agent.yaml', filename: 'coder.agent.yaml' },
    { label: 'the .relavium.yaml fallback (no .agent.yaml)', filename: 'coder.relavium.yaml' },
    { label: 'the bare .yaml fallback (last in the chain)', filename: 'coder.yaml' },
  ])('discovers a bare --agent id under agents/ via the $label suffix', ({ filename }) => {
    const projectConfigDir = join(dir, '.relavium');
    mkdirSync(join(projectConfigDir, 'agents'), { recursive: true });
    writeFileSync(join(projectConfigDir, 'agents', filename), AGENT_YAML);
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

  it('rejects an oversized .agent.yaml before reading it (the agent kind of the shared size cap)', () => {
    const path = join(dir, 'huge.agent.yaml');
    writeFileSync(path, 'a'.repeat(MAX_SOURCE_CHARS + 1)); // one byte over the shared cap
    let caught: unknown;
    try {
      resolveChatAgent(path, { cwd: dir, projectConfigDir: undefined, defaultModel: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('agent'); // the `kind` is substituted into the diagnostic
      expect(caught.message).toContain('size limit');
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
