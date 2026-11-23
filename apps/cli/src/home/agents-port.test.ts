/**
 * The agents list's read ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the project's `.relavium/agents` directory in, rows that name their entries by index out. Every test reads a
 * temporary project written by the test, with a temporary operator home beside it: never the operator's own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_PROMPT_HEAD_CHARS } from '../history/agents-model.js';
import { createAgentsPort } from './agents-port.js';

// A key-shaped string, built from parts so no literal credential sits in the source.
const KEY = `sk-${'A1b2C3d4E5'.repeat(3)}`;
const MASK = '[REDACTED]';

/** A valid agent file. A JSON string is a valid YAML scalar, so the prompt can hold any text. */
function agentYaml(id: string, extra: Record<string, unknown> = {}, prompt = 'You review code.') {
  const fields: Record<string, unknown> = {
    id,
    name: `Agent ${id}`,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    system_prompt: prompt,
    ...extra,
  };
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')}\n`;
}

describe('createAgentsPort', () => {
  let proj: string;
  let home: string;
  let configDir: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'relavium-agents-port-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-agents-home-'));
    configDir = join(proj, '.relavium');
    mkdirSync(configDir);
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function write(name: string, body: string): void {
    const dir = join(configDir, 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, 'utf8');
  }

  /** A port over `projectConfigDir`, which is always said: no default stands in for an `undefined` the test means. */
  const portOver = (projectConfigDir: string | undefined | (() => string | undefined)) =>
    createAgentsPort({ projectConfigDir, cwd: proj, homeDir: home });
  const port = () => portOver(configDir);

  it('reads the project’s .relavium/agents directory: a row per file, ready ones with their detail, sorted by slug', () => {
    // The file names sort the other way from the ids, so an order that follows the files is not the order by slug.
    write(
      'b-reviewer.agent.yaml',
      agentYaml('reviewer', {
        tools: ['read_file', 'grep'],
        temperature: 0.3,
        reasoning_effort: 'high',
        model: 'claude-opus-4-8',
      }),
    );
    write('a-writer.agent.yaml', agentYaml('writer', { provider: 'openai', model: 'gpt-5' }));
    // A workflow is not an agent: its directory is not read.
    mkdirSync(join(configDir, 'workflows'));
    writeFileSync(join(configDir, 'workflows', 'flow.relavium.yaml'), 'not read\n');

    const read = port().read();
    expect(read.model.total).toBe(2);
    expect(read.model.rows.map((row) => [row.slug, row.state, row.name, row.entryIndex])).toEqual([
      ['reviewer', 'ready', 'Agent reviewer', 0],
      ['writer', 'ready', 'Agent writer', 1],
    ]);
    expect(read.model.rows[0]?.detail).toEqual({
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      tools: ['read_file', 'grep'],
      toolsMore: 0,
      temperature: 0.3,
      reasoningEffort: 'high',
      promptHead: 'You review code.',
    });
    expect(read.model.rows[1]?.detail).toMatchObject({ provider: 'openai', model: 'gpt-5' });
    expect(read.model.rows[0]?.path).toBe(join('.relavium', 'agents', 'b-reviewer.agent.yaml'));
  });

  it('names each row’s entry by its index, and a read already taken keeps naming the files it listed', () => {
    write('alpha.agent.yaml', agentYaml('alpha'));
    write('beta.agent.yaml', agentYaml('beta'));
    const agents = port();

    const first = agents.read();
    expect(first.slugOf(0)).toBe('alpha');
    expect(first.slugOf(1)).toBe('beta');
    expect(first.slugOf(2)).toBeUndefined();
    expect(first.slugOf(-1)).toBeUndefined();
    expect(first.pathOf(1)).toBe(join('.relavium', 'agents', 'beta.agent.yaml'));
    expect(first.pathOf(2)).toBeUndefined();

    // The catalog changes under the read: it keeps what it listed, and the next read lists what is there now.
    rmSync(join(configDir, 'agents', 'alpha.agent.yaml'));
    expect(first.slugOf(0)).toBe('alpha');
    const second = agents.read();
    expect(second.model.rows.map((row) => row.slug)).toEqual(['beta']);
    expect(second.slugOf(0)).toBe('beta');
  });

  it('holds the whole parsed definition of each ready entry, as the catalog read it, and none for a file that did not parse', () => {
    write('alpha.agent.yaml', agentYaml('alpha', { tools: ['read_file'], temperature: 0.3 }, 'P'));
    write('broken.agent.yaml', 'id: [unclosed\n');
    const read = port().read();
    // The definition is the parse of the file, not the page's scrubbed text: a key-shaped prompt is held whole.
    expect(read.definitionOf(0)).toEqual({
      id: 'alpha',
      name: 'Agent alpha',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'P',
      tools: ['read_file'],
      temperature: 0.3,
    });
    expect(read.slugOf(1)).toBe('broken');
    expect(read.definitionOf(1), 'a file that did not parse has none').toBeUndefined();
    expect(read.definitionOf(2)).toBeUndefined();
    // A read already taken keeps the definition it listed when the file changes under it.
    write('alpha.agent.yaml', agentYaml('alpha', { tools: ['read_file', 'write_file'] }, 'P'));
    expect(read.definitionOf(0)?.tools).toEqual(['read_file']);
  });

  it('keeps an invalid file as a row with a reason and none of its contents', () => {
    // A schema violation (an unknown key whose value is a key-shaped string) and a YAML syntax fault, both full of text a leak
    // would show; the id a refused file takes is its file stem.
    write(
      'torn.agent.yaml',
      `${agentYaml('torn')}secret_note: ${KEY}\nbogus: UNIQUE-FILE-CONTENT\n`,
    );
    write('syntax.agent.yaml', `id: x\nnote: [${KEY} UNIQUE-FILE-CONTENT\n  : : :\n`);

    const read = port().read();
    expect(read.model.rows.map((row) => [row.slug, row.state])).toEqual([
      ['syntax', 'invalid'],
      ['torn', 'invalid'],
    ]);
    for (const row of read.model.rows) {
      expect(row).not.toHaveProperty('detail');
      expect(row.note ?? '').not.toBe('');
    }
    const shown = JSON.stringify(read.model);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain('UNIQUE-FILE-CONTENT');
    expect(shown).not.toContain('You review code.');
    // The reason names the field and says what is wrong, as `relavium list` does for the same file.
    expect(read.model.rows[1]?.note).toContain('unknown key');
    expect(read.slugOf(1)).toBe('torn');
  });

  it('masks a key in a ready agent’s head and shows nothing of the prompt past it, whatever the file holds', () => {
    const prompt = `Use ${KEY} to call the service. ${'Be thorough. '.repeat(40)}TAIL-MARKER`;
    write('keyed.agent.yaml', agentYaml('keyed', {}, prompt));

    const read = port().read();
    const detail = read.model.rows[0]?.detail;
    expect(detail?.promptHead).toContain(MASK);
    expect(detail?.promptHead.length).toBeLessThanOrEqual(AGENT_PROMPT_HEAD_CHARS + 1);
    const shown = JSON.stringify(read.model);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain('TAIL-MARKER');
  });

  it('lists nothing for a project with no agents directory, and for no project at all', () => {
    // `.relavium/` exists but holds no `agents/` directory.
    expect(port().read().model).toEqual({ rows: [], total: 0 });
    // No project directory at all, said outright (a string, then a function that finds none).
    const noProject = createAgentsPort({ projectConfigDir: undefined, cwd: proj, homeDir: home });
    expect(noProject.read().model).toEqual({ rows: [], total: 0 });
    expect(noProject.read().slugOf(0)).toBeUndefined();
    expect(portOver(() => undefined).read().model).toEqual({ rows: [], total: 0 });
  });

  it('finds the project directory afresh on every read when it is given a function', () => {
    let current: string | undefined;
    const agents = portOver(() => current);
    expect(agents.read().model.total).toBe(0);

    write('late.agent.yaml', agentYaml('late'));
    current = configDir;
    expect(agents.read().model.rows.map((row) => row.slug)).toEqual(['late']);

    current = undefined;
    expect(agents.read().model.total).toBe(0);
  });

  it('hands the operator home it is given to the catalog read: a project that is the home is refused, not listed', () => {
    // The project-artifact rule refuses a catalog that resolves into the home's own global configuration. Here the home IS the
    // project, so `.relavium/` is the global configuration: the read must say so, and list nothing. A port that dropped the
    // home would fall back to the process's (a temporary one in these tests) and list the file.
    write('inside.agent.yaml', agentYaml('inside'));
    const homeIsProject = createAgentsPort({
      projectConfigDir: configDir,
      cwd: proj,
      homeDir: proj,
    });
    expect(() => homeIsProject.read()).toThrow(/home or global configuration/);
    // The same project under another home reads.
    expect(
      port()
        .read()
        .model.rows.map((row) => row.slug),
    ).toEqual(['inside']);
  });
});
