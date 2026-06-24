import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import { discoverCatalog } from './catalog.js';

const VALID_WORKFLOW = `schema_version: '1.0'
workflow:
  id: hello
  name: Hello
  tags: [greeting]
  nodes:
    - { id: a, type: input }
    - { id: b, type: output }
  edges:
    - { from: a, to: b }
`;

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

// A workflow that interpolates a `secret`-typed input into agent text → WorkflowSecretLeakError at parse.
const SECRET_LEAK_WORKFLOW = `schema_version: '1.0'
workflow:
  id: leaky
  inputs:
    - name: api_key
      type: secret
  agents:
    - id: ag
      model: claude-sonnet-4-6
      provider: anthropic
      system_prompt: 'system'
  nodes:
    - id: n
      type: agent
      agent_ref: ag
      prompt_template: 'use {{inputs.api_key}}'
  edges: []
`;

describe('discoverCatalog', () => {
  let proj: string;
  let configDir: string;

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'relavium-catalog-'));
    configDir = join(proj, '.relavium');
    mkdirSync(configDir);
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  function write(kind: 'workflows' | 'agents', name: string, body: string): void {
    const dir = join(configDir, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, 'utf8');
  }

  it('parses valid workflows (id, name, tags) and flags an unparseable one', () => {
    write('workflows', 'hello.relavium.yaml', VALID_WORKFLOW);
    write('workflows', 'broken.relavium.yaml', INVALID_WORKFLOW);

    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'workflows' });
    expect(entries.map((e) => e.slug)).toEqual(['broken', 'hello']); // sorted by slug

    const hello = entries.find((e) => e.slug === 'hello');
    expect(hello?.valid).toBe(true);
    expect(hello?.name).toBe('Hello');
    expect(hello?.tags).toEqual(['greeting']);
    expect(hello?.path).toBe('.relavium/workflows/hello.relavium.yaml'); // cwd-relative

    const broken = entries.find((e) => e.slug === 'broken'); // slug falls back to the filename stem
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toBeTruthy();
  });

  it('parses agents (no tags) under the agents kind', () => {
    write('agents', 'summarizer.agent.yaml', VALID_AGENT);

    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'agents' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe('summarizer');
    expect(entries[0]?.name).toBe('Summarizer');
    expect(entries[0]?.valid).toBe(true);
    expect(entries[0]?.tags).toEqual([]);
  });

  it('returns an empty catalog for a missing directory', () => {
    // No `workflows/` was created under .relavium/.
    expect(discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'workflows' })).toEqual(
      [],
    );
  });

  it('flags an invalid agent file (only valid agents are listed clean)', () => {
    write('agents', 'broken.agent.yaml', 'id: Not_Kebab\nmodel: m\n'); // missing required fields + bad id

    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'agents' });
    const broken = entries.find((e) => e.slug === 'broken'); // slug falls back to the filename stem
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toBeTruthy();
  });

  it('throws an exit-2 invocation error when the catalog path is not a directory (ENOTDIR)', () => {
    // A regular file where the `workflows/` directory is expected → readdirSync raises ENOTDIR (not ENOENT),
    // which is a real fault, not an empty catalog. Cross-platform (no chmod/perms needed).
    writeFileSync(join(configDir, 'workflows'), 'not a directory', 'utf8');

    try {
      discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'workflows' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isCliError(err)).toBe(true);
      if (isCliError(err)) {
        expect(err.code).toBe('invalid_invocation');
        expect(err.exitCode).toBe(EXIT_CODES.invalidInvocation);
        expect(err.message).toMatch(/could not read the workflows catalog/);
      }
    }
  });

  it('flags a secret-taint workflow as invalid, surfacing only the taint path (no value)', () => {
    write('workflows', 'leaky.relavium.yaml', SECRET_LEAK_WORKFLOW);

    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'workflows' });
    const leaky = entries.find((e) => e.slug === 'leaky'); // slug falls back to the filename stem
    expect(leaky?.valid).toBe(false);
    // The reason is the field-named WorkflowSecretLeakError message — a taint PATH (`inputs.api_key`), the
    // symbol reference, never a resolved value (there is none at parse time). `parseReason` only echoes a
    // typed WorkflowParseError/AgentParseError message, so no arbitrary error text reaches the entry.
    expect(leaky?.error).toContain('inputs.api_key');
  });

  it('ignores non-YAML files', () => {
    write('workflows', 'hello.relavium.yaml', VALID_WORKFLOW);
    write('workflows', 'README.md', '# not a workflow');

    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'workflows' });
    expect(entries.map((e) => e.slug)).toEqual(['hello']);
  });

  it('discovers .relavium.yml files and strips the compound suffix for the slug fallback', () => {
    // An invalid `.relavium.yml` so the slug comes from the filename stem — proving fileStem strips
    // `.relavium.yml` to `review` (not `review.relavium`) and that `.yml` is a discovered extension.
    write('workflows', 'review.relavium.yml', INVALID_WORKFLOW);

    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'workflows' });
    expect(entries.map((e) => e.slug)).toEqual(['review']);
    expect(entries[0]?.valid).toBe(false);
  });

  it('flags a symlinked .yaml that resolves to a non-regular file (no readFileSync hang)', () => {
    write('workflows', 'hello.relavium.yaml', VALID_WORKFLOW); // ensures workflows/ exists
    // A `.yaml` symlinked to a DIRECTORY (statSync follows it → not a regular file). The same guard rejects a
    // symlink to a FIFO/character device (e.g. /dev/zero) BEFORE readFileSync — which would otherwise block.
    symlinkSync(configDir, join(configDir, 'workflows', 'loop.yaml'));

    const entries = discoverCatalog({ projectConfigDir: configDir, cwd: proj, kind: 'workflows' });
    const loop = entries.find((e) => e.slug === 'loop');
    expect(loop?.valid).toBe(false);
    expect(loop?.error).toBe('not a regular file');
  });
});
