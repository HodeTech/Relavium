/**
 * What `relavium import` does when a catalog directory of the project is a symbolic link: the observable outcome (stdout, stderr, the
 * `--json` line, the exit code or the fault with its code, exit code and exact words, and what every directory holds afterwards).
 * `import-characterisation.test.ts` pins the command for every project WITHOUT a link and is not edited by this file: these cases are
 * the ones its own note excludes ("a case's fixture is a symlinked subdirectory"), kept apart so that file stays byte-for-byte what it
 * was. Each case runs by both routes (`importCommand` and the dispatch path the program and the in-app commands use) in a fresh
 * project and must give one outcome.
 *
 * The hole these close: `.relavium/agents` (or `workflows`) a link to a directory elsewhere took the written file there, because the
 * rule about global state looks only at home and the global configuration, and the id check scans a kind's directory only when it
 * must (`--force` skips the same-kind scan).
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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

const AGENT = `# external agent (comment dropped on import)
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const AGENT_CANONICAL =
  'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n';

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
  /** What the directory a link points at holds afterwards, by file name. */
  readonly linked: readonly string[];
  /** The file written at the link's target, if any. */
  readonly written: string | undefined;
}

type Route = 'direct' | 'dispatch';
const ROUTES: readonly Route[] = ['direct', 'dispatch'];

interface Case {
  /** Where the link `.relavium/agents` points, as a function of the project and a directory outside it. */
  readonly linkTo: (project: string, outside: string) => string;
  /** Where the file would land if it were written at the link's target, relative to that target. */
  readonly landing: string;
  readonly force: boolean;
  readonly json?: boolean;
}

const globalOptions = (dir: string, json: boolean): GlobalOptions => ({
  json,
  color: false,
  cwd: dir,
  configPath: undefined,
  verbosity: 'normal',
});

let outside = '';
beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), 'relavium-import-link-out-'));
});
afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

async function run(route: Route, c: Case): Promise<Outcome> {
  const project = mkdtempSync(join(tmpdir(), 'relavium-import-link-run-'));
  try {
    mkdirSync(join(project, '.relavium'), { recursive: true });
    writeFileSync(join(project, 'incoming.agent.yaml'), AGENT);
    const linkTarget = c.linkTo(project, outside);
    mkdirSync(linkTarget, { recursive: true });
    symlinkSync(linkTarget, join(project, '.relavium', 'agents'));
    const { io, out, err } = captureIo();
    const global = globalOptions(project, c.json ?? false);
    let exit: number | undefined;
    let fault: Fault | undefined;
    try {
      exit =
        route === 'direct'
          ? importCommand({ path: 'incoming.agent.yaml', force: c.force }, { io, global })
          : await executeCommand(
              'import',
              { positionals: ['incoming.agent.yaml'], options: c.force ? { force: true } : {} },
              { io, global },
            );
    } catch (cause) {
      if (!(cause instanceof CliError)) throw cause;
      fault = { code: cause.code, exitCode: cause.exitCode, message: cause.message };
    }
    const landed = join(linkTarget, c.landing);
    let written: string | undefined;
    try {
      written = readFileSync(landed, 'utf8');
    } catch {
      written = undefined;
    }
    return { exit, fault, out: out(), err: err(), linked: readdirSync(linkTarget), written };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

async function expectBoth(c: Case, expected: Outcome): Promise<void> {
  for (const route of ROUTES) {
    expect(await run(route, c), route).toEqual(expected);
  }
}

const invalid = (message: string): Fault => ({ code: 'invalid_invocation', exitCode: 2, message });

describe.skipIf(process.platform === 'win32')('a catalog directory that is a link', () => {
  describe('a link that leaves the project', () => {
    const leaving: Case['linkTo'] = (_project, outsideDir) => join(outsideDir, 'elsewhere');

    it('with --force: refused in fixed words naming the directory, nothing written through the link, nothing printed', async () => {
      await expectBoth(
        { linkTo: leaving, landing: 'reviewer.agent.yaml', force: true },
        {
          exit: undefined,
          fault: invalid(
            'The target directory is a link that leaves the project: .relavium/agents.',
          ),
          out: '',
          err: '',
          linked: [],
          written: undefined,
        },
      );
    });

    it('with --force and --json: the same refusal, and no JSON line', async () => {
      await expectBoth(
        { linkTo: leaving, landing: 'reviewer.agent.yaml', force: true, json: true },
        {
          exit: undefined,
          fault: invalid(
            'The target directory is a link that leaves the project: .relavium/agents.',
          ),
          out: '',
          err: '',
          linked: [],
          written: undefined,
        },
      );
    });

    it('without --force: still refused, nothing written (the id check scans the directory first and says so in its own words)', async () => {
      await expectBoth(
        { linkTo: leaving, landing: 'reviewer.agent.yaml', force: false },
        {
          exit: undefined,
          fault: invalid('could not read the agents catalog directory.'),
          out: '',
          err: '',
          linked: [],
          written: undefined,
        },
      );
    });
  });

  describe('a link that stays inside the project', () => {
    const inside: Case['linkTo'] = (project) => join(project, '.relavium', 'shared');

    it('is followed: the file is written where the link leads, and the command names that place', async () => {
      for (const force of [false, true]) {
        await expectBoth(
          { linkTo: inside, landing: 'reviewer.agent.yaml', force },
          {
            exit: 0,
            fault: undefined,
            out: "Imported agent 'reviewer' to .relavium/shared/reviewer.agent.yaml\n",
            err: '',
            linked: ['reviewer.agent.yaml'],
            written: AGENT_CANONICAL,
          },
        );
      }
    });

    it('--json names the same place', async () => {
      await expectBoth(
        { linkTo: inside, landing: 'reviewer.agent.yaml', force: true, json: true },
        {
          exit: 0,
          fault: undefined,
          out: '{"id":"reviewer","kind":"agent","path":".relavium/shared/reviewer.agent.yaml"}\n',
          err: '',
          linked: ['reviewer.agent.yaml'],
          written: AGENT_CANONICAL,
        },
      );
    });
  });
});
