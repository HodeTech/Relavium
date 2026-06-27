import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { exportCommand, type ExportCommandDeps } from './export.js';

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: code-review
  name: Code Review
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;

const AGENT = `# my reviewer (this comment must be dropped on export)
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
mcp_servers:
  - id: gh
    transport: stdio
    command: gh-mcp
    env: { TOKEN: '{{secrets.gh}}' }
`;

describe('exportCommand (2.J)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-export-'));
    mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(join(cwd, '.relavium', 'workflows', 'code-review.relavium.yaml'), WORKFLOW);
    writeFileSync(join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml'), AGENT);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function deps(json = false): { d: ExportCommandDeps; out: () => string } {
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

  it('exports a workflow by id to <id>.relavium.yaml in cwd, re-importable + comment-free', () => {
    const { d, out } = deps();
    expect(exportCommand({ id: 'code-review', force: false }, d)).toBe(EXIT_CODES.success);
    const written = readFileSync(join(cwd, 'code-review.relavium.yaml'), 'utf8');
    expect(written).toContain('id: code-review');
    expect(written).toContain('schema_version'); // a valid, re-importable workflow
    expect(out()).toContain("Exported workflow 'code-review'");
  });

  it('exports an agent by id, dropping authored comments and KEEPING the {{secrets.*}} placeholder', () => {
    const { d } = deps();
    expect(exportCommand({ id: 'reviewer', force: false }, d)).toBe(EXIT_CODES.success);
    const written = readFileSync(join(cwd, 'reviewer.agent.yaml'), 'utf8');
    expect(written).not.toContain('this comment must be dropped'); // comments stripped (share-safety)
    expect(written).toContain('{{secrets.gh}}'); // the placeholder survives — never a resolved value
    expect(written).toContain('id: reviewer');
  });

  it('honors --out and emits a machine record under --json', () => {
    const { d, out } = deps(true);
    expect(exportCommand({ id: 'reviewer', out: 'shared/copy.agent.yaml', force: false }, d)).toBe(
      EXIT_CODES.success,
    );
    expect(readFileSync(join(cwd, 'shared', 'copy.agent.yaml'), 'utf8')).toContain('id: reviewer');
    const record = JSON.parse(out().trim()) as { id: string; kind: string; path: string };
    expect(record).toMatchObject({ id: 'reviewer', kind: 'agent' });
  });

  it('rejects an unknown id with a clean exit-2 CliError', () => {
    const { d } = deps();
    try {
      exportCommand({ id: 'ghost', force: false }, d);
      expect.unreachable('an unknown id must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.code).toBe('invalid_invocation');
      expect(err.message).toContain("no workflow or agent with id 'ghost'");
    }
  });

  it('rejects an id that names BOTH a workflow and an agent (ambiguous) with exit 2', () => {
    writeFileSync(
      join(cwd, '.relavium', 'agents', 'code-review.agent.yaml'),
      AGENT.replace('id: reviewer', 'id: code-review'),
    );
    const { d } = deps();
    try {
      exportCommand({ id: 'code-review', force: false }, d);
      expect.unreachable('an ambiguous id must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.message).toContain('names both a workflow and an agent');
    }
  });

  it('refuses to overwrite an existing target without --force, then overwrites WITH it', () => {
    const target = join(cwd, 'reviewer.agent.yaml');
    writeFileSync(target, 'pre-existing\n');
    const { d } = deps();
    try {
      exportCommand({ id: 'reviewer', force: false }, d);
      expect.unreachable('an existing target without --force must throw');
    } catch (err) {
      if (!isCliError(err)) throw err;
      expect(err.message).toContain('already exists — pass --force');
    }
    // With --force it overwrites cleanly.
    expect(exportCommand({ id: 'reviewer', force: true }, d)).toBe(EXIT_CODES.success);
    expect(readFileSync(target, 'utf8')).toContain('id: reviewer');
  });
});
