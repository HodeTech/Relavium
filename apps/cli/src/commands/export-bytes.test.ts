/**
 * `relavium export` keeps its observable output byte for byte ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4, increment 4b): the command was split into a PREPARE (the destination and the content, nothing written) and a COMMIT
 * (the write) so the Defined tab's export card can show the destination before anything is written. The expectations below were taken from
 * the command BEFORE the split and are the oracle: the same stdout, the same stderr (what the dispatcher prints for a refusal, through
 * `toUserFacing`), the same exit code and the same file bytes for every path, a refusal included.
 *
 * Every project here is a temporary directory; nothing reads or writes an operator home.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toUserFacing } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { exportCommand } from './export.js';

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

const AGENT = `# a comment that the export drops
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;

/** What one run of the command left: its return, what it threw as the dispatcher would print it, and both streams. */
interface Observed {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let cwd = '';
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'relavium-export-bytes-'));
  mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
  mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
  writeFileSync(join(cwd, '.relavium', 'workflows', 'code-review.relavium.yaml'), WORKFLOW);
  writeFileSync(join(cwd, '.relavium', 'agents', 'reviewer.agent.yaml'), AGENT);
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function observe(
  args: { readonly id: string; readonly out?: string; readonly force: boolean },
  json = false,
): Observed {
  const { io, out, err } = captureIo();
  const global: GlobalOptions = {
    json,
    color: false,
    cwd,
    configPath: undefined,
    verbosity: 'normal',
  };
  try {
    const exitCode = exportCommand(args, { io, global });
    return { exitCode, stdout: out(), stderr: err() };
  } catch (cause) {
    // The dispatcher prints a refusal as its user-facing message on stderr and exits with its code.
    const refusal = toUserFacing(cause);
    return { exitCode: refusal.exitCode, stdout: out(), stderr: `${refusal.message}\n${err()}` };
  }
}

describe('relavium export is unchanged by the prepare/commit split', () => {
  it('a workflow: the human line, exit 0, and the exact bytes of the file', () => {
    const seen = observe({ id: 'code-review', force: false });
    expect(seen).toEqual({
      exitCode: 0,
      stdout: "Exported workflow 'code-review' to code-review.relavium.yaml\n",
      stderr: '',
    });
    expect(readFileSync(join(cwd, 'code-review.relavium.yaml'), 'utf8')).toBe(EXPORTED_WORKFLOW);
  });

  it('an agent under --json: the one record line, exit 0, and the exact bytes of the file', () => {
    const seen = observe({ id: 'reviewer', out: 'shared/copy.agent.yaml', force: false }, true);
    expect(seen).toEqual({
      exitCode: 0,
      stdout: `{"id":"reviewer","kind":"agent","path":"${join('shared', 'copy.agent.yaml').replaceAll('\\', '\\\\')}"}\n`,
      stderr: '',
    });
    expect(readFileSync(join(cwd, 'shared', 'copy.agent.yaml'), 'utf8')).toBe(EXPORTED_AGENT);
  });

  it('an existing file without --force is refused: nothing on stdout, its message and its code on stderr, the file untouched', () => {
    writeFileSync(join(cwd, 'reviewer.agent.yaml'), 'pre-existing\n');
    const seen = observe({ id: 'reviewer', force: false });
    expect(seen).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'reviewer.agent.yaml already exists — pass --force to overwrite\n',
    });
    expect(readFileSync(join(cwd, 'reviewer.agent.yaml'), 'utf8')).toBe('pre-existing\n');
  });

  it('--force over the same file overwrites it and prints the same line a fresh export does', () => {
    writeFileSync(join(cwd, 'reviewer.agent.yaml'), 'pre-existing\n');
    const seen = observe({ id: 'reviewer', force: true });
    expect(seen).toEqual({
      exitCode: 0,
      stdout: "Exported agent 'reviewer' to reviewer.agent.yaml\n",
      stderr: '',
    });
    expect(readFileSync(join(cwd, 'reviewer.agent.yaml'), 'utf8')).toBe(EXPORTED_AGENT);
  });

  it('a destination that is a directory is refused as it was: cwd-relative, exit 2, nothing on stdout', () => {
    mkdirSync(join(cwd, 'blocked.agent.yaml'), { recursive: true });
    const seen = observe({ id: 'reviewer', out: 'blocked.agent.yaml', force: true });
    expect(seen).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'cannot write blocked.agent.yaml: the target path is not a file\n',
    });
  });

  it('an unknown id is refused before any destination is computed', () => {
    const seen = observe({ id: 'ghost', force: false });
    expect(seen).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: "no workflow or agent with id 'ghost' in this project.\n",
    });
  });

  it('an id that names both a workflow and an agent is refused as ambiguous', () => {
    writeFileSync(
      join(cwd, '.relavium', 'agents', 'code-review.agent.yaml'),
      AGENT.replace('id: reviewer', 'id: code-review'),
    );
    const seen = observe({ id: 'code-review', force: false });
    expect(seen).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: "'code-review' names both a workflow and an agent — rename one to disambiguate.\n",
    });
  });
});

// The canonical re-serialization of the two fixtures, as the command wrote them before the split.
const EXPORTED_WORKFLOW = [
  'schema_version: "1.0"',
  'workflow:',
  '  edges:',
  '    - from: s',
  '      to: o',
  '  id: code-review',
  '  name: Code Review',
  '  nodes:',
  '    - id: s',
  '      type: input',
  '    - id: o',
  '      type: output',
  '',
].join('\n');
const EXPORTED_AGENT = [
  'id: reviewer',
  'model: claude-sonnet-4-6',
  'provider: anthropic',
  'system_prompt: Review the code.',
  '',
].join('\n');
