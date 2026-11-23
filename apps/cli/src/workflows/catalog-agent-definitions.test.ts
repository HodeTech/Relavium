import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_CATALOG_FILES, discoverAgentDefinitions, discoverCatalog } from './catalog.js';

/**
 * `discoverAgentDefinitions` (MVP-8 step 5): the agents catalog with each valid file's parsed definition kept beside its entry, for
 * the Home's agent browser. It must be the SAME hardened read as `discoverCatalog({ kind: 'agents' })`, so these tests hold that
 * the two agree on every file, valid or refused, and that a refused file carries no definition.
 */

const VALID_AGENT = `id: summarizer
name: Summarizer
model: claude-sonnet-4-6
provider: anthropic
system_prompt: Summarize the input.
tools: [read_file]
temperature: 0.2
reasoning_effort: low
`;

describe('discoverAgentDefinitions', () => {
  let proj: string;
  let home: string;
  let configDir: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'relavium-agent-defs-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-agent-defs-home-'));
    configDir = join(proj, '.relavium');
    mkdirSync(join(configDir, 'agents'), { recursive: true });
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const write = (name: string, body: string): void =>
    writeFileSync(join(configDir, 'agents', name), body, 'utf8');
  const opts = () => ({ projectConfigDir: configDir, cwd: proj, homeDir: home });

  it('keeps the parsed definition of a valid agent beside its entry, and none for a file that did not parse', () => {
    write('summarizer.agent.yaml', VALID_AGENT);
    write('schema.agent.yaml', 'id: Not_Kebab\nmodel: m\n');
    write('syntax.agent.yaml', 'id: x\n  : : :');

    const items = discoverAgentDefinitions(opts());
    expect(
      items.map((item) => [item.entry.slug, item.entry.valid, item.agent === undefined]),
    ).toEqual([
      ['schema', false, true],
      ['summarizer', true, false],
      ['syntax', false, true],
    ]);
    const agent = items.find((item) => item.entry.slug === 'summarizer')?.agent;
    expect(agent).toMatchObject({
      id: 'summarizer',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      system_prompt: 'Summarize the input.',
      tools: ['read_file'],
      temperature: 0.2,
      reasoning_effort: 'low',
    });
  });

  it('sorts by slug, the agent’s id, and not by the order the files come in', () => {
    // The file names sort the other way from the ids (a-zeta … z-alpha), so a list left in directory order is not the list by id.
    const named: readonly (readonly [string, string])[] = [
      ['a.agent.yaml', 'zeta'],
      ['b.agent.yaml', 'mike'],
      ['m.agent.yaml', 'echo'],
      ['z.agent.yaml', 'alpha'],
    ];
    for (const [file, id] of named) {
      write(file, VALID_AGENT.replace('id: summarizer', `id: ${id}`));
    }
    // A refused file sorts by its file stem among them.
    write('golf.agent.yaml', 'id: Not_Kebab\nmodel: m\n');

    const slugs = discoverAgentDefinitions(opts()).map((item) => item.entry.slug);
    expect(slugs).toEqual(['alpha', 'echo', 'golf', 'mike', 'zeta']);
  });

  it('lists exactly the entries discoverCatalog lists for the agents catalog, refused files included', () => {
    write('summarizer.agent.yaml', VALID_AGENT);
    write('schema.agent.yaml', 'id: Not_Kebab\nmodel: m\n');
    const outside = join(proj, 'private.yaml');
    writeFileSync(outside, VALID_AGENT);
    symlinkSync(outside, join(configDir, 'agents', 'escaped.yaml'), 'file');
    write('empty.agent.yaml', '');

    const items = discoverAgentDefinitions(opts());
    expect(items.map((item) => item.entry)).toEqual(discoverCatalog({ ...opts(), kind: 'agents' }));
    // The escaped file is refused by the same containment rule, so it has no definition to show.
    const escaped = items.find((item) => item.entry.slug === 'escaped');
    expect(escaped?.entry.error).toBe('outside the project catalog');
    expect(escaped?.agent).toBeUndefined();
  });

  it('returns nothing for a project with no agents directory', () => {
    rmSync(join(configDir, 'agents'), { recursive: true });
    expect(discoverAgentDefinitions(opts())).toEqual([]);
  });

  it('refuses a directory of too many files, as the catalog does', () => {
    for (let n = 0; n <= MAX_CATALOG_FILES; n++) write(`a-${String(n).padStart(4, '0')}.yaml`, '');
    expect(() => discoverAgentDefinitions(opts())).toThrow(/too many agent files/);
  });
});
