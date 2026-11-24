/**
 * The OBSERVABLE behaviour of `relavium import`, pinned before `importCommand` was split into a prepare and a commit (MVP-8 step 5,
 * increment 6: the Home's `/import` card calls the same two steps). Every case here was run against the unsplit command and passed
 * unedited; it must stay green unedited after the split: stdout, stderr, the `--json` line, the exit code (or the fault, with its
 * code, exit code and exact words) and every file the command left under the project, byte for byte.
 *
 * Each case runs twice in a fresh project, once through `importCommand` and once through the dispatch path the program and the
 * in-app commands use (`executeCommand('import', ...)`), and both must produce the one expected outcome.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { executeCommand } from './dispatch.js';
import { importCommand } from './import.js';

const WORKFLOW = `schema_version: '1.0'
workflow:
  id: code-review
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;
/** What the canonical re-serialization of {@link WORKFLOW} is, byte for byte. */
const WORKFLOW_CANONICAL =
  'schema_version: "1.0"\nworkflow:\n  edges:\n    - from: s\n      to: o\n  id: code-review\n  nodes:\n    - id: s\n      type: input\n    - id: o\n      type: output\n';

const AGENT = `# external agent (comment dropped on import)
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const AGENT_CANONICAL =
  'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n';
const AGENT_OTHER_CANONICAL =
  'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: A different prompt.\n';

const WORKFLOW_PATH = '.relavium/workflows/code-review.relavium.yaml';
const AGENT_PATH = '.relavium/agents/reviewer.agent.yaml';

const LITERAL = 'sk-importedSyntheticCredential123456789';
const CREDENTIAL_WARNING =
  'Warning: authored definition has 1 string(s) matching known credential shapes. Authored content is preserved in files and run snapshots; review literals before sharing or running. This check is best effort.\n';

interface Fault {
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
}
interface Outcome {
  readonly exit: number | undefined;
  readonly fault: Fault | undefined;
  readonly out: string;
  readonly err: string;
  /** Every file and directory under `.relavium`, by cwd-relative path (a directory is `<dir>`), after the command. */
  readonly files: Readonly<Record<string, string>>;
}

let outside = '';
beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), 'relavium-import-char-out-'));
});
afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

const globalOptions = (dir: string, json: boolean): GlobalOptions => ({
  json,
  color: false,
  cwd: dir,
  configPath: undefined,
  verbosity: 'normal',
});

function filesUnder(dir: string, prefix: string, into: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      into[rel] = '<dir>';
      filesUnder(join(dir, entry.name), rel, into);
    } else {
      into[rel] = readFileSync(join(dir, entry.name), 'utf8');
    }
  }
}

function faultOf(cause: unknown): Fault {
  if (!(cause instanceof CliError)) throw cause;
  return { code: cause.code, exitCode: cause.exitCode, message: cause.message };
}

type Route = 'direct' | 'dispatch';
const ROUTES: readonly Route[] = ['direct', 'dispatch'];

interface Case {
  /** Written into the project before the command runs. */
  readonly seed?: (project: string, outsideDir: string) => void;
  readonly path: string | ((outsideDir: string) => string);
  readonly force?: boolean;
  readonly json?: boolean;
}

/** Runs a case in a fresh project, by one route. */
async function run(route: Route, c: Case): Promise<Outcome> {
  const project = mkdtempSync(join(tmpdir(), 'relavium-import-char-run-'));
  try {
    mkdirSync(join(project, '.relavium'), { recursive: true });
    c.seed?.(project, outside);
    const path = typeof c.path === 'string' ? c.path : c.path(outside);
    const force = c.force ?? false;
    const global = globalOptions(project, c.json ?? false);
    const { io, out, err } = captureIo();
    let exit: number | undefined;
    let fault: Fault | undefined;
    try {
      exit =
        route === 'direct'
          ? importCommand({ path, force }, { io, global })
          : await executeCommand(
              'import',
              { positionals: [path], options: force ? { force: true } : {} },
              { io, global },
            );
    } catch (cause) {
      fault = faultOf(cause);
    }
    const files: Record<string, string> = {};
    filesUnder(join(project, '.relavium'), '.relavium', files);
    return { exit, fault, out: out(), err: err(), files };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

/** Both routes must produce `expected`. */
async function expectBoth(c: Case, expected: Outcome): Promise<void> {
  for (const route of ROUTES) {
    expect(await run(route, c), route).toEqual(expected);
  }
}

const seedFile =
  (name: string, content: string) =>
  (project: string): void => {
    writeFileSync(join(project, name), content);
  };
const seedAgentCatalog = (project: string): void => {
  mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
  writeFileSync(join(project, AGENT_PATH), AGENT);
};
const invalid = (message: string): Fault => ({
  code: 'invalid_invocation',
  exitCode: 2,
  message,
});

describe('a valid file is imported, and the command says so', () => {
  it('a workflow file, human output', async () => {
    await expectBoth(
      { seed: seedFile('incoming.relavium.yaml', WORKFLOW), path: 'incoming.relavium.yaml' },
      {
        exit: 0,
        fault: undefined,
        out: `Imported workflow 'code-review' to ${WORKFLOW_PATH}\n`,
        err: '',
        files: {
          '.relavium/workflows': '<dir>',
          [WORKFLOW_PATH]: WORKFLOW_CANONICAL,
        },
      },
    );
  });

  it('a workflow file, --json', async () => {
    await expectBoth(
      {
        seed: seedFile('incoming.relavium.yaml', WORKFLOW),
        path: 'incoming.relavium.yaml',
        json: true,
      },
      {
        exit: 0,
        fault: undefined,
        out: `{"id":"code-review","kind":"workflow","path":"${WORKFLOW_PATH}"}\n`,
        err: '',
        files: {
          '.relavium/workflows': '<dir>',
          [WORKFLOW_PATH]: WORKFLOW_CANONICAL,
        },
      },
    );
  });

  it('an agent file (its comment is dropped), human output and --json', async () => {
    const files = { '.relavium/agents': '<dir>', [AGENT_PATH]: AGENT_CANONICAL };
    await expectBoth(
      { seed: seedFile('downloaded.agent.yaml', AGENT), path: 'downloaded.agent.yaml' },
      {
        exit: 0,
        fault: undefined,
        out: `Imported agent 'reviewer' to ${AGENT_PATH}\n`,
        err: '',
        files,
      },
    );
    await expectBoth(
      { seed: seedFile('downloaded.agent.yaml', AGENT), path: 'downloaded.agent.yaml', json: true },
      {
        exit: 0,
        fault: undefined,
        out: `{"id":"reviewer","kind":"agent","path":"${AGENT_PATH}"}\n`,
        err: '',
        files,
      },
    );
  });

  it('a bare .yaml is sniffed, as a workflow and as an agent', async () => {
    await expectBoth(
      { seed: seedFile('thing.yaml', WORKFLOW), path: 'thing.yaml' },
      {
        exit: 0,
        fault: undefined,
        out: `Imported workflow 'code-review' to ${WORKFLOW_PATH}\n`,
        err: '',
        files: { '.relavium/workflows': '<dir>', [WORKFLOW_PATH]: WORKFLOW_CANONICAL },
      },
    );
    await expectBoth(
      { seed: seedFile('thing.yaml', AGENT), path: 'thing.yaml' },
      {
        exit: 0,
        fault: undefined,
        out: `Imported agent 'reviewer' to ${AGENT_PATH}\n`,
        err: '',
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: AGENT_CANONICAL },
      },
    );
  });

  it('a source outside the project, given as an absolute path', async () => {
    await expectBoth(
      {
        seed: (_project, outsideDir) => writeFileSync(join(outsideDir, 'far.agent.yaml'), AGENT),
        path: (outsideDir) => join(outsideDir, 'far.agent.yaml'),
      },
      {
        exit: 0,
        fault: undefined,
        out: `Imported agent 'reviewer' to ${AGENT_PATH}\n`,
        err: '',
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: AGENT_CANONICAL },
      },
    );
  });
});

describe('a collision is refused unless --force is passed', () => {
  const other = AGENT.replace('Review the code.', 'A different prompt.');
  const seed = (project: string): void => {
    seedAgentCatalog(project);
    writeFileSync(join(project, 'other.agent.yaml'), other);
  };

  it('without --force: a fault, nothing written, nothing printed, the old file kept', async () => {
    await expectBoth(
      { seed, path: 'other.agent.yaml' },
      {
        exit: undefined,
        fault: invalid(
          "agent 'reviewer' already exists in this project — pass --force to overwrite.",
        ),
        out: '',
        err: '',
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: AGENT },
      },
    );
  });

  it('with --force: the file is overwritten with the new canonical content', async () => {
    await expectBoth(
      { seed, path: 'other.agent.yaml', force: true },
      {
        exit: 0,
        fault: undefined,
        out: `Imported agent 'reviewer' to ${AGENT_PATH}\n`,
        err: '',
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: AGENT_OTHER_CANONICAL },
      },
    );
  });

  it('the same id in the other catalog is refused with and without --force, and nothing is written', async () => {
    const seedCross = (project: string): void => {
      mkdirSync(join(project, '.relavium', 'workflows'), { recursive: true });
      writeFileSync(
        join(project, '.relavium', 'workflows', 'reviewer.relavium.yaml'),
        WORKFLOW.replace('code-review', 'reviewer'),
      );
      writeFileSync(join(project, 'incoming.agent.yaml'), AGENT);
    };
    for (const force of [false, true]) {
      await expectBoth(
        { seed: seedCross, path: 'incoming.agent.yaml', force },
        {
          exit: undefined,
          fault: invalid(
            "'reviewer' already exists as a workflow in this project — an id must be unique across agents and workflows; rename one.",
          ),
          out: '',
          err: '',
          files: {
            '.relavium/workflows': '<dir>',
            '.relavium/workflows/reviewer.relavium.yaml': WORKFLOW.replace(
              'code-review',
              'reviewer',
            ),
          },
        },
      );
    }
  });

  it('a directory sitting at the target is refused as it always was (EEXIST without --force, not-a-file with it)', async () => {
    const seedDir = (project: string): void => {
      mkdirSync(join(project, AGENT_PATH), { recursive: true });
      writeFileSync(join(project, 'incoming.agent.yaml'), AGENT);
    };
    await expectBoth(
      { seed: seedDir, path: 'incoming.agent.yaml' },
      {
        exit: undefined,
        fault: invalid(`${AGENT_PATH} already exists — pass --force to overwrite`),
        out: '',
        err: '',
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: '<dir>' },
      },
    );
    await expectBoth(
      { seed: seedDir, path: 'incoming.agent.yaml', force: true },
      {
        exit: undefined,
        fault: invalid(`cannot write ${AGENT_PATH}: the target path is not a file`),
        out: '',
        err: '',
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: '<dir>' },
      },
    );
  });
});

describe('a file that is not a valid workflow or agent is refused, and nothing is written', () => {
  const none = {};
  it('malformed YAML under the agent hint', async () => {
    const result = await run('direct', {
      seed: seedFile('broken.agent.yaml', 'id: 123\nthis: is: not: valid'),
      path: 'broken.agent.yaml',
    });
    expect(result.exit).toBeUndefined();
    expect(result.fault?.code).toBe('invalid_invocation');
    expect(result.fault?.exitCode).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toBe('');
    expect(result.files).toEqual(none);
    // The dispatch path says exactly the same.
    expect(
      await run('dispatch', {
        seed: seedFile('broken.agent.yaml', 'id: 123\nthis: is: not: valid'),
        path: 'broken.agent.yaml',
      }),
    ).toEqual(result);
  });

  it('a bare .yaml that is neither: both reasons, in the one message', async () => {
    const c = { seed: seedFile('mystery.yaml', 'foo: bar\n'), path: 'mystery.yaml' };
    const direct = await run('direct', c);
    expect(direct.fault?.message).toMatch(
      /^mystery\.yaml is not a valid workflow \(.+\) or agent \(.+\)\.$/su,
    );
    expect(direct.out).toBe('');
    expect(direct.err).toBe('');
    expect(direct.files).toEqual(none);
    expect(await run('dispatch', c)).toEqual(direct);
  });

  it('a workflow-hinted file with an invalid body says what the parser says, word for word', async () => {
    const c = {
      seed: seedFile('bad.relavium.yaml', 'schema_version: "1.0"\nworkflow:\n  id: x\n'),
      path: 'bad.relavium.yaml',
    };
    const direct = await run('direct', c);
    expect(direct.fault?.code).toBe('invalid_invocation');
    expect(direct.fault?.message).toBe('nodes: missing — expected array (and 1 more issue)');
    expect(direct.files).toEqual(none);
    expect(await run('dispatch', c)).toEqual(direct);
  });
});

describe('a source that cannot be read is refused, with the path it was given and never the absolute one', () => {
  it('a missing file', async () => {
    await expectBoth(
      { path: 'nope.yaml' },
      { exit: undefined, fault: invalid('no file at nope.yaml'), out: '', err: '', files: {} },
    );
  });

  it('a missing file given as an absolute path outside the project is named relative to the project', async () => {
    await expectBoth(
      { path: (outsideDir) => join(outsideDir, 'gone.yaml') },
      {
        exit: undefined,
        fault: invalid(`no file at ${join('..', outside.split('/').pop() ?? '', 'gone.yaml')}`),
        out: '',
        err: '',
        files: {},
      },
    );
  });

  it('a directory is not a regular file', async () => {
    await expectBoth(
      { seed: (project) => mkdirSync(join(project, 'a-dir')), path: 'a-dir' },
      {
        exit: undefined,
        fault: invalid('a-dir is not a regular file'),
        out: '',
        err: '',
        files: {},
      },
    );
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a file the process may not read',
    async () => {
      const seed = (project: string): void => {
        writeFileSync(join(project, 'locked.agent.yaml'), AGENT);
        chmodSync(join(project, 'locked.agent.yaml'), 0o000);
      };
      await expectBoth(
        { seed, path: 'locked.agent.yaml' },
        {
          exit: undefined,
          fault: invalid('could not read locked.agent.yaml'),
          out: '',
          err: '',
          files: {},
        },
      );
    },
  );

  it('a file over the byte ceiling is refused before it is read', async () => {
    const seed = (project: string): void => {
      writeFileSync(join(project, 'huge.yaml'), 'x');
      truncateSync(join(project, 'huge.yaml'), 8 * 1024 * 1024 + 1);
    };
    await expectBoth(
      { seed, path: 'huge.yaml' },
      {
        exit: undefined,
        fault: invalid('huge.yaml exceeds the size limit'),
        out: '',
        err: '',
        files: {},
      },
    );
  });

  it('a file under the byte ceiling but over the parser’s character limit is refused by the parser', async () => {
    const c = {
      seed: seedFile('long.agent.yaml', `${AGENT}# ${'a'.repeat(2 * 1024 * 1024)}\n`),
      path: 'long.agent.yaml',
    };
    const direct = await run('direct', c);
    expect(direct.fault?.code).toBe('invalid_invocation');
    expect(direct.fault?.message).toContain('character parse limit');
    expect(direct.out).toBe('');
    expect(direct.files).toEqual({});
    expect(await run('dispatch', c)).toEqual(direct);
  });
});

describe('a snapshot-literal warning goes to stderr, after the write, and never carries the value', () => {
  const seedLiteral = (project: string): void => {
    writeFileSync(join(project, 'incoming.agent.yaml'), AGENT.replace('Review the code.', LITERAL));
  };
  const canonical = `id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: ${LITERAL}\n`;

  it('human output: the file, the line on stdout, the warning on stderr', async () => {
    await expectBoth(
      { seed: seedLiteral, path: 'incoming.agent.yaml' },
      {
        exit: 0,
        fault: undefined,
        out: `Imported agent 'reviewer' to ${AGENT_PATH}\n`,
        err: CREDENTIAL_WARNING,
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: canonical },
      },
    );
  });

  it('--json: the JSON line alone on stdout, the warning on stderr', async () => {
    await expectBoth(
      { seed: seedLiteral, path: 'incoming.agent.yaml', json: true },
      {
        exit: 0,
        fault: undefined,
        out: `{"id":"reviewer","kind":"agent","path":"${AGENT_PATH}"}\n`,
        err: CREDENTIAL_WARNING,
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: canonical },
      },
    );
  });

  it('a refused import warns of nothing', async () => {
    await expectBoth(
      {
        seed: (project) => {
          seedLiteral(project);
          mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
          writeFileSync(join(project, AGENT_PATH), AGENT);
        },
        path: 'incoming.agent.yaml',
      },
      {
        exit: undefined,
        fault: invalid(
          "agent 'reviewer' already exists in this project — pass --force to overwrite.",
        ),
        out: '',
        err: '',
        files: { '.relavium/agents': '<dir>', [AGENT_PATH]: AGENT },
      },
    );
  });
});
