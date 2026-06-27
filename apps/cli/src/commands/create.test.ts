import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAgent, parseWorkflow } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreatePrompter, CreateSpec } from '../authoring/authoring.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { createCommand, type CreateCommandDeps } from './create.js';

const AGENT_SPEC: CreateSpec = {
  kind: 'agent',
  name: 'Code Reviewer',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'Review the code precisely.',
  tools: ['read_file'],
};

/** A scripted prompter that yields a fixed spec (or null to model a cancel) — no clack/TTY. */
function scriptedPrompter(spec: CreateSpec | null): CreatePrompter {
  return { gather: () => Promise.resolve(spec) };
}

describe('createCommand (2.J)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-create-'));
    mkdirSync(join(cwd, '.relavium'), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function deps(
    prompter: CreatePrompter | undefined,
    json = false,
  ): {
    d: CreateCommandDeps;
    out: () => string;
    err: () => string;
  } {
    const { io, out, err } = captureIo();
    const global: GlobalOptions = {
      json,
      color: false,
      cwd,
      configPath: undefined,
      verbosity: 'normal',
    };
    return { d: { io, global, ...(prompter === undefined ? {} : { prompter }) }, out, err };
  }

  it('scaffolds an agent from the wizard answers as schema-valid YAML at .relavium/agents/<id>.agent.yaml', async () => {
    const { d, out } = deps(scriptedPrompter(AGENT_SPEC));
    expect(await createCommand({ force: false }, d)).toBe(EXIT_CODES.success);
    const path = join(cwd, '.relavium', 'agents', 'code-reviewer.agent.yaml');
    const yaml = readFileSync(path, 'utf8');
    expect(() => parseAgent(yaml)).not.toThrow(); // a valid agent that would `run`
    const agent = parseAgent(yaml);
    expect(agent.id).toBe('code-reviewer');
    expect(agent.name).toBe('Code Reviewer'); // the human name kept (differs from the slug)
    expect(agent.tools).toEqual(['read_file']);
    expect(out()).toContain("Created agent 'code-reviewer'");
  });

  it('scaffolds a minimal single-agent workflow (input → agent → output) that parses', async () => {
    const { d } = deps(scriptedPrompter({ ...AGENT_SPEC, kind: 'workflow', name: 'triage' }));
    expect(await createCommand({ force: false }, d)).toBe(EXIT_CODES.success);
    const yaml = readFileSync(join(cwd, '.relavium', 'workflows', 'triage.relavium.yaml'), 'utf8');
    const def = parseWorkflow(yaml);
    expect(def.workflow.id).toBe('triage');
    expect((def.workflow.agents ?? []).length).toBe(1); // the inline agent
    expect(def.workflow.nodes.map((n) => n.type)).toEqual(['input', 'agent', 'output']);
  });

  it('rejects a name with no usable id characters as a clean exit-2 CliError', async () => {
    const { d } = deps(scriptedPrompter({ ...AGENT_SPEC, name: '!!! ???' }));
    try {
      await createCommand({ force: false }, d);
      expect.unreachable('an unusable name must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.message).toContain('at least one ASCII letter or digit');
    }
  });

  it('a cancelled wizard writes nothing and exits 0', async () => {
    const { d, err } = deps(scriptedPrompter(null));
    expect(await createCommand({ force: false }, d)).toBe(EXIT_CODES.success);
    expect(err()).toContain('create cancelled');
    expect(existsSync(join(cwd, '.relavium', 'agents'))).toBe(false); // nothing written
  });

  it('rejects a name colliding with an existing entry (exit 2), then overwrites WITH --force', async () => {
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(
      join(cwd, '.relavium', 'agents', 'code-reviewer.agent.yaml'),
      'id: code-reviewer\nprovider: anthropic\nmodel: m\nsystem_prompt: old\n',
    );
    const { d } = deps(scriptedPrompter(AGENT_SPEC));
    try {
      await createCommand({ force: false }, d);
      expect.unreachable('a colliding name must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.message).toContain("agent 'code-reviewer' already exists");
    }
    expect(await createCommand({ force: true }, d)).toBe(EXIT_CODES.success);
    expect(
      readFileSync(join(cwd, '.relavium', 'agents', 'code-reviewer.agent.yaml'), 'utf8'),
    ).toContain('Review the code precisely.');
  });

  it('fails loud (exit 2) under --json with no injected prompter — a wizard needs an interactive terminal', async () => {
    const { d } = deps(undefined, true); // no prompter + --json ⇒ the headless guard fires before any clack call
    try {
      await createCommand({ force: false }, d);
      expect.unreachable('a headless create must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.message).toContain('needs an interactive terminal');
    }
  });
});
