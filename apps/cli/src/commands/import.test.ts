import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { importCommand, type ImportCommandDeps } from './import.js';

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: code-review
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;

const AGENT = `# external agent (comment dropped on import)
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;

describe('importCommand (2.J)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-import-'));
    mkdirSync(join(cwd, '.relavium'), { recursive: true }); // an existing project to import into
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function deps(json = false): { d: ImportCommandDeps; out: () => string } {
    const { io, out } = captureIo();
    const global: GlobalOptions = {
      json,
      color: false,
      cwd,
      configPath: undefined,
      verbosity: 'normal',
    };
    return { d: { io, global }, out };
  }

  function seed(name: string, content: string): string {
    writeFileSync(join(cwd, name), content);
    return name;
  }

  it('imports an external .agent.yaml into .relavium/agents/<id>.agent.yaml, comment-free', () => {
    seed('downloaded.agent.yaml', AGENT);
    const { d, out } = deps();
    expect(importCommand({ path: 'downloaded.agent.yaml', force: false }, d)).toBe(
      EXIT_CODES.success,
    );
    const written = readFileSync(join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml'), 'utf8');
    expect(written).toContain('id: reviewer');
    expect(written).not.toContain('comment dropped'); // re-serialized, comments stripped
    expect(out()).toContain("Imported agent 'reviewer'");
  });

  it('sniffs a bare .yaml workflow and lands it under .relavium/workflows/', () => {
    seed('thing.yaml', WORKFLOW); // no .relavium / .agent hint — content-sniffed as a workflow
    const { d } = deps();
    expect(importCommand({ path: 'thing.yaml', force: false }, d)).toBe(EXIT_CODES.success);
    expect(existsSync(join(cwd, '.relavium', 'workflows', 'code-review.relavium.yaml'))).toBe(true);
  });

  it('sniffs a bare .yaml agent (no top-level `workflow:`) and lands it under .relavium/agents/', () => {
    seed('thing.yaml', AGENT); // the OTHER sniff branch — workflow parse fails, agent parse succeeds
    const { d } = deps();
    expect(importCommand({ path: 'thing.yaml', force: false }, d)).toBe(EXIT_CODES.success);
    expect(existsSync(join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml'))).toBe(true);
  });

  it('rejects a bare .yaml that is neither a workflow nor an agent, naming both reasons (exit 2)', () => {
    seed('mystery.yaml', 'foo: bar\n'); // valid YAML, but matches neither schema → the dual-failure branch
    const { d } = deps();
    try {
      importCommand({ path: 'mystery.yaml', force: false }, d);
      expect.unreachable('a doc that is neither must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.code).toBe('invalid_invocation');
      expect(err.message).toContain('workflow'); // both typed parse reasons are surfaced…
      expect(err.message).toContain('agent'); // …so the author sees why it fit neither
    }
  });

  it('rejects a malformed YAML with a clean exit-2 CliError', () => {
    seed('broken.agent.yaml', 'id: 123\nthis: is: not: valid');
    const { d } = deps();
    try {
      importCommand({ path: 'broken.agent.yaml', force: false }, d);
      expect.unreachable('a malformed file must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.code).toBe('invalid_invocation');
    }
  });

  it('rejects a slug collision with exit 2, then overwrites WITH --force', () => {
    // Pre-seed an agent `reviewer` in the catalog, then import another doc with the same id.
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml'), AGENT);
    seed('other.agent.yaml', AGENT.replace('Review the code.', 'A different prompt.'));
    const { d } = deps();
    try {
      importCommand({ path: 'other.agent.yaml', force: false }, d);
      expect.unreachable('a slug collision must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.message).toContain("agent 'reviewer' already exists in this project");
    }
    // --force overwrites the canonical entry with the new content.
    expect(importCommand({ path: 'other.agent.yaml', force: true }, d)).toBe(EXIT_CODES.success);
    expect(readFileSync(join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml'), 'utf8')).toContain(
      'A different prompt.',
    );
  });

  it('rejects an import whose id is already used by the OTHER catalog (cross-kind), even with --force', () => {
    // A workflow `reviewer` exists; importing an AGENT `reviewer` collides project-globally — rejected, and
    // --force cannot resolve a cross-kind clash (it would leave both files and make `export reviewer` ambiguous).
    mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
    writeFileSync(
      join(cwd, '.relavium', 'workflows', 'reviewer.relavium.yaml'),
      "schema_version: '1.0'\nworkflow:\n  id: reviewer\n  nodes:\n    - { id: i, type: input }\n    - { id: o, type: output }\n  edges:\n    - { from: i, to: o }\n",
    );
    seed('incoming.agent.yaml', AGENT); // AGENT declares `id: reviewer`
    const { d } = deps();
    for (const force of [false, true]) {
      try {
        importCommand({ path: 'incoming.agent.yaml', force }, d);
        expect.unreachable('a cross-kind id must throw');
      } catch (err) {
        if (!isCliError(err)) throw err;
        expect(err.message).toContain('already exists as a workflow');
      }
    }
    expect(existsSync(join(cwd, '.relavium', 'agents'))).toBe(false); // nothing written
  });

  it('rejects a missing source path with exit 2', () => {
    const { d } = deps();
    try {
      importCommand({ path: 'nope.yaml', force: false }, d);
      expect.unreachable('a missing file must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.message).toContain('no file at');
    }
  });
});
