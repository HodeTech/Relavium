/**
 * `relavium import` split into a prepare and a commit (MVP-8 step 5, increment 6): what each half does on its own. The command's
 * whole observable behaviour, byte for byte, is pinned in `import-characterisation.test.ts` (written before the split, unedited since);
 * this file proves what only the split adds: the first half writes and prints nothing, the second writes exactly the plan, and the
 * notices the command prints are collected by the first and written only after the second.
 */
import {
  existsSync,
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

import { SlugClashError } from '../authoring/authoring.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { commitImport, importCommand, prepareImport } from './import.js';

const AGENT = `# a comment that the canonical copy drops
id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const AGENT_CANONICAL =
  'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n';
const LITERAL = 'sk-importedSyntheticCredential123456789';
const WORKFLOW = `schema_version: '1.0'
workflow:
  id: reviewer
  nodes:
    - { id: s, type: input }
    - { id: o, type: output }
  edges:
    - { from: s, to: o }
`;
const AGENT_PATH = '.relavium/agents/reviewer.agent.yaml';
const AGENT_DIRECTORY = '.relavium/agents';

let cwd = '';
let home = '';
let outside = '';
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'relavium-import-split-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-import-split-home-'));
  outside = mkdtempSync(join(tmpdir(), 'relavium-import-split-outside-'));
  mkdirSync(join(cwd, '.relavium'), { recursive: true });
  writeFileSync(join(cwd, 'incoming.agent.yaml'), AGENT);
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const global = (): GlobalOptions => ({
  json: false,
  color: false,
  cwd,
  configPath: undefined,
  verbosity: 'normal',
});
/** Everything under the project, recursively and sorted: the whole of "nothing was written". */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort();
}
const target = (): string => join(cwd, AGENT_PATH);

describe('prepareImport writes and prints nothing, and says what commitImport will write', () => {
  it('returns the plan for a valid file and leaves the project exactly as it was', () => {
    const before = tree(cwd);
    const plan = prepareImport(
      { path: 'incoming.agent.yaml', force: false },
      { global: global(), homeDir: home },
    );
    expect(plan).toEqual({
      kind: 'agent',
      slug: 'reviewer',
      source: 'incoming.agent.yaml',
      target: join(cwd, AGENT_PATH),
      targetDisplay: AGENT_PATH,
      projectConfigDir: join(cwd, '.relavium'),
      content: AGENT_CANONICAL,
      bytes: Buffer.byteLength(AGENT_CANONICAL, 'utf8'),
      force: false,
      warnings: [],
    });
    expect(tree(cwd), 'a prepare creates no directory and no file').toEqual(before);
  });

  it('counts the bytes the file takes, not the characters', () => {
    writeFileSync(
      join(cwd, 'wide.agent.yaml'),
      AGENT.replace('Review the code.', 'Gözden geçir — 日本語'),
    );
    const plan = prepareImport(
      { path: 'wide.agent.yaml', force: false },
      { global: global(), homeDir: home },
    );
    expect(plan.content).toContain('Gözden geçir — 日本語');
    expect(plan.bytes).toBe(Buffer.byteLength(plan.content, 'utf8'));
    expect(plan.bytes).toBeGreaterThan(plan.content.length);
  });

  it('collects the notices about the literals and writes none of them', () => {
    writeFileSync(join(cwd, 'secret.agent.yaml'), AGENT.replace('Review the code.', LITERAL));
    const plan = prepareImport(
      { path: 'secret.agent.yaml', force: false },
      { global: global(), homeDir: home },
    );
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(
      /^Warning: authored definition has 1 string\(s\) matching known credential shapes\..+best effort\.\n$/su,
    );
    expect(plan.warnings.join('')).not.toContain(LITERAL);
    expect(plan.content, 'the literal is kept as written, never redacted').toContain(LITERAL);
  });

  it('refuses a same-kind id the project has, as a SlugClashError that says it is the clash --force answers', () => {
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), AGENT);
    try {
      prepareImport(
        { path: 'incoming.agent.yaml', force: false },
        { global: global(), homeDir: home },
      );
      expect.unreachable('a collision must be refused');
    } catch (cause) {
      expect(cause).toBeInstanceOf(SlugClashError);
      if (!(cause instanceof SlugClashError)) throw cause;
      expect(cause.clash).toBe('same-kind');
      expect([cause.kind, cause.slug]).toEqual(['agent', 'reviewer']);
      expect(isCliError(cause), 'still the command’s own fault').toBe(true);
      expect(cause.name).toBe('CliError');
      expect(cause.code).toBe('invalid_invocation');
      expect(cause.exitCode).toBe(2);
      expect(cause.message).toBe(
        "agent 'reviewer' already exists in this project — pass --force to overwrite.",
      );
    }
    // With --force the same plan is returned: the force only decides whether the write may replace.
    expect(
      prepareImport(
        { path: 'incoming.agent.yaml', force: true },
        { global: global(), homeDir: home },
      ).force,
    ).toBe(true);
  });

  it('refuses the other kind’s id whatever is passed, and says it is the clash nothing replaces', () => {
    mkdirSync(join(cwd, '.relavium', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.relavium', 'workflows', 'reviewer.relavium.yaml'), WORKFLOW);
    for (const force of [false, true]) {
      try {
        prepareImport({ path: 'incoming.agent.yaml', force }, { global: global(), homeDir: home });
        expect.unreachable('a cross-kind id must be refused');
      } catch (cause) {
        if (!(cause instanceof SlugClashError)) throw cause;
        expect(cause.clash).toBe('other-kind');
        expect(cause.message).toContain("'reviewer' already exists as a workflow");
      }
    }
  });

  it('reads the project rules against the home it is handed, not the process’s', () => {
    // The project IS the home it is handed: global state is no project, refused with the command's own words.
    expect(() =>
      prepareImport(
        { path: 'incoming.agent.yaml', force: false },
        { global: global(), homeDir: cwd },
      ),
    ).toThrow('global state, not a project');
    expect(
      () =>
        prepareImport(
          { path: 'incoming.agent.yaml', force: false },
          { global: global(), homeDir: home },
        ).targetDisplay,
    ).not.toThrow();
  });
});

describe('commitImport writes exactly the plan, once, and never replaces without force', () => {
  const plan = (force = false) =>
    prepareImport({ path: 'incoming.agent.yaml', force }, { global: global(), homeDir: home });

  it('writes the plan’s content byte for byte, creating the catalog directory', () => {
    const planned = plan();
    expect(existsSync(join(cwd, '.relavium', 'agents'))).toBe(false);
    commitImport(planned);
    expect(readFileSync(target())).toEqual(Buffer.from(planned.content, 'utf8'));
    expect(readFileSync(target())).toHaveLength(planned.bytes);
  });

  it('refuses a file that is there, in the command’s words, and keeps it', () => {
    const planned = plan();
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), 'someone else wrote this\n');
    expect(() => commitImport(planned)).toThrow(
      `${AGENT_PATH} already exists — pass --force to overwrite`,
    );
    expect(readFileSync(target(), 'utf8')).toBe('someone else wrote this\n');
  });

  it('replaces only a plan that was made with force', () => {
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), 'old\n');
    commitImport(plan(true));
    expect(readFileSync(target(), 'utf8')).toBe(AGENT_CANONICAL);
  });
});

describe.skipIf(process.platform === 'win32')(
  'a catalog directory that is a link: the plan shows where the file really goes, and a link out of the project is refused',
  () => {
    const LEAVES = `The target directory is a link that leaves the project: ${AGENT_DIRECTORY}.`;
    const prepare = (force = false) =>
      prepareImport({ path: 'incoming.agent.yaml', force }, { global: global(), homeDir: home });

    it('a link that stays inside the project is followed: the plan names the real directory, and the write lands in it', () => {
      mkdirSync(join(cwd, '.relavium', 'shared'), { recursive: true });
      symlinkSync(join(cwd, '.relavium', 'shared'), join(cwd, '.relavium', 'agents'));
      const plan = prepare();
      expect(plan.targetDisplay).toBe('.relavium/shared/reviewer.agent.yaml');
      expect(plan.target).toBe(join(cwd, '.relavium', 'shared', 'reviewer.agent.yaml'));
      commitImport(plan);
      expect(readFileSync(join(cwd, '.relavium', 'shared', 'reviewer.agent.yaml'), 'utf8')).toBe(
        AGENT_CANONICAL,
      );
    });

    it('a link that leaves the project is refused by the prepare, in fixed words that name the directory and not the absolute path', () => {
      symlinkSync(outside, join(cwd, '.relavium', 'agents'));
      let caught: unknown;
      try {
        prepare(true);
      } catch (cause) {
        caught = cause;
      }
      expect(isCliError(caught)).toBe(true);
      if (!isCliError(caught)) return;
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.exitCode).toBe(2);
      expect(caught.message).toBe(LEAVES);
      expect(caught.message).not.toContain(outside);
      expect(readdirSync(outside), 'nothing was written through the link').toEqual([]);
    });

    it('a link put in after the plan was made is refused by the commit, which writes nothing', () => {
      const planned = prepare();
      mkdirSync(join(cwd, '.relavium'), { recursive: true });
      symlinkSync(outside, join(cwd, '.relavium', 'agents'));
      expect(() => commitImport(planned)).toThrow(LEAVES);
      expect(readdirSync(outside), 'nothing was written through the link').toEqual([]);
    });

    it('a link that points at nothing is refused by the commit too: an unresolved link is no evidence that the write stays inside', () => {
      const planned = prepare();
      symlinkSync(join(outside, 'missing'), join(cwd, '.relavium', 'agents'));
      expect(() => commitImport(planned)).toThrow(
        'The target directory could not be resolved safely. Check directory access and symbolic links, then retry.',
      );
      expect(readdirSync(outside)).toEqual([]);
    });
  },
);

describe('importCommand prints the collected notices only after the write', () => {
  it('the file exists when the first notice is written, and the output line follows it', () => {
    writeFileSync(join(cwd, 'secret.agent.yaml'), AGENT.replace('Review the code.', LITERAL));
    const { io } = captureIo();
    const events: string[] = [];
    const watching = {
      ...io,
      writeErr: (text: string) => {
        events.push(`err:${existsSync(target()) ? 'written' : 'absent'}:${text.slice(0, 8)}`);
      },
      writeOut: (text: string) => {
        events.push(`out:${text.slice(0, 8)}`);
      },
    };
    expect(
      importCommand(
        { path: 'secret.agent.yaml', force: false },
        { io: watching, global: global(), homeDir: home },
      ),
    ).toBe(0);
    expect(events).toEqual(['err:written:Warning:', 'out:Imported']);
  });

  it('a refused import has written and printed nothing', () => {
    mkdirSync(join(cwd, '.relavium', 'agents'), { recursive: true });
    writeFileSync(target(), 'kept\n');
    writeFileSync(join(cwd, 'secret.agent.yaml'), AGENT.replace('Review the code.', LITERAL));
    const { io, out, err } = captureIo();
    expect(() =>
      importCommand(
        { path: 'secret.agent.yaml', force: false },
        { io, global: global(), homeDir: home },
      ),
    ).toThrow('already exists');
    expect([out(), err()]).toEqual(['', '']);
    expect(readFileSync(target(), 'utf8')).toBe('kept\n');
  });
});
