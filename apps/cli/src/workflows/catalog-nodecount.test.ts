import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverCatalog, type CatalogEntry } from './catalog.js';

/**
 * The node count of a catalog entry (MVP-8 step 4, the Defined tab's "how big is it"): the number of nodes the parsed
 * workflow declares, present on a valid workflow entry and nowhere else. A file that does not parse keeps its refusal
 * and gets no count: there is no document to count, and a guessed number would be shown as if it were read.
 */

/** A chain of `count` nodes: an input, a transform per extra step, and an output. */
function chain(id: string, count: number): string {
  const middle = Array.from({ length: Math.max(0, count - 2) }, (_, index) => `step-${index}`);
  const ids = ['start', ...middle, 'done'];
  const nodes = ids.map((nodeId, index) =>
    index === 0
      ? `    - { id: ${nodeId}, type: input }`
      : index === ids.length - 1
        ? `    - { id: ${nodeId}, type: output }`
        : `    - { id: ${nodeId}, type: transform, transform: '${nodeId}' }`,
  );
  const edges = ids.slice(1).map((nodeId, index) => `    - { from: ${ids[index]}, to: ${nodeId} }`);
  return `schema_version: '1.0'\nworkflow:\n  id: ${id}\n  nodes:\n${nodes.join('\n')}\n  edges:\n${edges.join('\n')}\n`;
}

const INVALID_WORKFLOW = `schema_version: '1.0'
workflow:
  nodes: []
`;

const VALID_AGENT = `id: summarizer
name: Summarizer
model: claude-sonnet-4-6
provider: anthropic
system_prompt: Summarize the input.
`;

describe('the node count of a catalog entry', () => {
  let project: string;
  let configDir: string;
  let home: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'relavium-catalog-nodecount-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-catalog-nodecount-home-'));
    configDir = join(project, '.relavium');
    mkdirSync(configDir);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function write(kind: 'workflows' | 'agents', name: string, body: string): void {
    const dir = join(configDir, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, 'utf8');
  }

  function entries(kind: 'workflows' | 'agents'): CatalogEntry[] {
    return discoverCatalog({ projectConfigDir: configDir, cwd: project, kind, homeDir: home });
  }

  it('is the number of nodes the workflow declares, for each workflow in the catalog', () => {
    write('workflows', 'two.relavium.yaml', chain('two', 2));
    write('workflows', 'five.relavium.yaml', chain('five', 5));
    write('workflows', 'nine.relavium.yaml', chain('nine', 9));

    const counts = Object.fromEntries(
      entries('workflows').map((entry) => [entry.slug, entry.nodeCount]),
    );
    expect(counts).toEqual({ two: 2, five: 5, nine: 9 });
  });

  it('counts a workflow that declares a single node as one, not as nothing', () => {
    write(
      'workflows',
      'solo.relavium.yaml',
      "schema_version: '1.0'\nworkflow:\n  id: solo\n  nodes:\n    - { id: only, type: input }\n  edges: []\n",
    );
    const [solo] = entries('workflows');
    expect(solo?.valid).toBe(true);
    expect(solo?.nodeCount).toBe(1);
  });

  it('gives a file that does not parse no count, and keeps its refusal', () => {
    write('workflows', 'broken.relavium.yaml', INVALID_WORKFLOW);
    write('workflows', 'fine.relavium.yaml', chain('fine', 3));

    const found = entries('workflows');
    const broken = found.find((entry) => entry.slug === 'broken');
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toBeTruthy();
    expect(broken).not.toHaveProperty('nodeCount');
    // The refusal is what it always was: one broken file does not take the count of its neighbour with it.
    expect(found.find((entry) => entry.slug === 'fine')?.nodeCount).toBe(3);
  });

  it('gives a file whose document is not a workflow at all no count either', () => {
    // YAML that is not even a mapping: the reason is the parser's, and there is nothing to count.
    write('workflows', 'scalar.relavium.yaml', 'just a string\n');
    const [entry] = entries('workflows');
    expect(entry?.valid).toBe(false);
    expect(entry).not.toHaveProperty('nodeCount');
  });

  it('has no count on an agent, which declares no nodes', () => {
    write('agents', 'summarizer.agent.yaml', VALID_AGENT);
    const [agent] = entries('agents');
    expect(agent?.valid).toBe(true);
    expect(agent).not.toHaveProperty('nodeCount');
  });
});
