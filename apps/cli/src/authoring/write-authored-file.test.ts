/**
 * `writeAuthoredFile` under `--force` must not write THROUGH a link (PR #102 review P0-1). `confineToProjectConfig` canonicalises the
 * directory of a target and says nothing about the target itself, so a file link committed to a repository
 * (`.relavium/agents/evil.agent.yaml -> ~/victim.txt`) took `import --force` out of the project: the `w` open follows the link.
 *
 * Every refusal here is asserted on BOTH sides: the fixed sentence, and that nothing was written (the victim's bytes, the link itself,
 * the directory's entries: no temporary file is left). Each case runs against the writer directly and through the commands that call
 * it (`import`, `export`, `create` share it; the Home's cards call the same two functions).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportCommand } from '../commands/export.js';
import { importCommand } from '../commands/import.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { writeAuthoredFile } from './authoring.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const NOT_PLAIN =
  'The target exists and is a link or not a regular file, so nothing was written. Remove it or choose another path, then retry.';

const AGENT = `id: evil
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const AGENT_CANONICAL =
  'id: evil\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n';

const VICTIM = 'precious: do not touch\n';

let root = '';
let project = '';
let home = '';
let outside = '';
let writer: ChildProcess | undefined;

beforeEach(() => {
  // A reset puts back the real implementation each spy wraps, so a fault one case injected never reaches the next.
  vi.mocked(fs.fsyncSync).mockReset();
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.writeFileSync).mockReset();
  root = mkdtempSync(join(tmpdir(), 'relavium-write-authored-'));
  project = join(root, 'project');
  home = join(root, 'home');
  outside = join(root, 'outside');
  for (const dir of [project, home, outside]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
  mkdirSync(join(project, '.relavium', 'workflows'), { recursive: true });
});
afterEach(() => {
  writer?.kill('SIGKILL');
  writer = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** The refusal `run` raises, or `undefined` when it returned. */
function refusal(
  run: () => unknown,
): { code: string; exitCode: number; message: string } | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    return { code: cause.code, exitCode: cause.exitCode, message: cause.message };
  }
}

const global = (cwd: string, json = false): GlobalOptions => ({
  json,
  color: false,
  cwd,
  configPath: undefined,
  verbosity: 'normal',
});

describe.skipIf(process.platform === 'win32')(
  'a link at the final component is never written through',
  () => {
    it('import --force over a file link: refused in fixed words, the victim and the link untouched, nothing else in the directory', () => {
      const victim = join(home, 'victim.txt');
      writeFileSync(victim, VICTIM);
      const link = join(project, '.relavium', 'agents', 'evil.agent.yaml');
      symlinkSync(victim, link);
      writeFileSync(join(project, 'evil.agent.yaml'), AGENT);
      const { io, out, err } = captureIo();

      const fault = refusal(() =>
        importCommand(
          { path: 'evil.agent.yaml', force: true },
          { io, global: global(project), homeDir: home },
        ),
      );

      expect(fault).toEqual({ code: 'invalid_invocation', exitCode: 2, message: NOT_PLAIN });
      expect(readFileSync(victim, 'utf8'), 'the file the link leads to').toBe(VICTIM);
      expect(lstatSync(link).isSymbolicLink(), 'the link was not replaced').toBe(true);
      expect(readlinkSync(link)).toBe(victim);
      expect(readdirSync(join(project, '.relavium', 'agents'))).toEqual(['evil.agent.yaml']);
      expect(out() + err(), 'nothing was announced for a write that did not happen').toBe('');
    });

    it('a link to a file inside the project is refused too: the rule is about the link, not where it leads', () => {
      const inside = join(project, 'notes.txt');
      writeFileSync(inside, VICTIM);
      const link = join(project, '.relavium', 'agents', 'evil.agent.yaml');
      symlinkSync(inside, link);
      const fault = refusal(() =>
        writeAuthoredFile(link, '.relavium/agents/evil.agent.yaml', AGENT_CANONICAL, true),
      );
      expect(fault?.message).toBe(NOT_PLAIN);
      expect(readFileSync(inside, 'utf8')).toBe(VICTIM);
    });

    it('a link that leads nowhere is refused under --force, and nothing is created where it points', () => {
      const aim = join(outside, 'created-by-the-write.txt');
      const link = join(project, '.relavium', 'agents', 'evil.agent.yaml');
      symlinkSync(aim, link);
      const fault = refusal(() =>
        writeAuthoredFile(link, '.relavium/agents/evil.agent.yaml', AGENT_CANONICAL, true),
      );
      expect(fault?.message).toBe(NOT_PLAIN);
      expect(existsSync(aim), 'the dangling link was not followed into existence').toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    it('without --force a link is "already exists" (O_EXCL never follows it), and nothing is written through it', () => {
      const victim = join(home, 'victim.txt');
      writeFileSync(victim, VICTIM);
      const link = join(project, '.relavium', 'agents', 'evil.agent.yaml');
      symlinkSync(victim, link);
      const aim = join(outside, 'dangling-target.txt');
      const dangling = join(project, '.relavium', 'agents', 'dangling.agent.yaml');
      symlinkSync(aim, dangling);
      for (const path of [link, dangling]) {
        const fault = refusal(() => writeAuthoredFile(path, 'x.yaml', AGENT_CANONICAL, false));
        expect(fault?.message).toBe('x.yaml already exists — pass --force to overwrite');
      }
      expect(readFileSync(victim, 'utf8')).toBe(VICTIM);
      expect(existsSync(aim)).toBe(false);
    });

    it('a link to a directory is refused under --force, and nothing is written into the directory', () => {
      const link = join(project, '.relavium', 'agents', 'evil.agent.yaml');
      symlinkSync(outside, link);
      const fault = refusal(() =>
        writeAuthoredFile(link, '.relavium/agents/evil.agent.yaml', AGENT_CANONICAL, true),
      );
      expect(fault?.message).toBe(NOT_PLAIN);
      expect(readdirSync(outside)).toEqual([]);
    });

    it('export --out over a file link, with --force: refused the same way (the explicit path is no escape from the final-component rule)', () => {
      mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
      writeFileSync(join(project, '.relavium', 'agents', 'evil.agent.yaml'), AGENT);
      const victim = join(home, 'victim.txt');
      writeFileSync(victim, VICTIM);
      symlinkSync(victim, join(project, 'copy.agent.yaml'));
      const { io, out } = captureIo();
      const fault = refusal(() =>
        exportCommand(
          { id: 'evil', out: 'copy.agent.yaml', force: true },
          { io, global: global(project), homeDir: home },
        ),
      );
      expect(fault).toEqual({ code: 'invalid_invocation', exitCode: 2, message: NOT_PLAIN });
      expect(readFileSync(victim, 'utf8')).toBe(VICTIM);
      expect(out()).toBe('');
    });

    it('export (default destination) over a file link, with --force: refused, victim untouched', () => {
      writeFileSync(join(project, '.relavium', 'agents', 'evil.agent.yaml'), AGENT);
      const victim = join(home, 'victim.txt');
      writeFileSync(victim, VICTIM);
      symlinkSync(victim, join(project, 'evil.agent.yaml'));
      const { io, out } = captureIo();
      const fault = refusal(() =>
        exportCommand({ id: 'evil', force: true }, { io, global: global(project), homeDir: home }),
      );
      expect(fault?.message).toBe(NOT_PLAIN);
      expect(readFileSync(victim, 'utf8')).toBe(VICTIM);
      expect(out()).toBe('');
    });
  },
);

describe('what --force does write', () => {
  it('replaces an existing regular file with the new bytes, keeps its permission bits and leaves no temporary file behind', () => {
    if (process.platform === 'win32') return;
    const path = join(project, '.relavium', 'agents', 'evil.agent.yaml');
    writeFileSync(path, 'old\n');
    // Group-writable: the umask narrows a created file to 0o644, so only an explicit `fchmod` of the new file can keep these bits.
    chmodSync(path, 0o664);
    writeAuthoredFile(path, 'x.yaml', AGENT_CANONICAL, true);
    expect(readFileSync(path, 'utf8')).toBe(AGENT_CANONICAL);
    expect(statSync(path).mode & 0o777, 'the file keeps the mode it had').toBe(0o664);
    expect(readdirSync(join(project, '.relavium', 'agents'))).toEqual(['evil.agent.yaml']);
  });

  it('creates the file (and its directories) when nothing is there, as --force always did', () => {
    const path = join(project, '.relavium', 'deeper', 'evil.agent.yaml');
    writeAuthoredFile(path, 'x.yaml', AGENT_CANONICAL, true);
    expect(readFileSync(path, 'utf8')).toBe(AGENT_CANONICAL);
  });

  it('a directory at the target keeps its own sentence under --force', () => {
    const path = join(project, '.relavium', 'agents', 'blocked.agent.yaml');
    mkdirSync(path);
    const fault = refusal(() => writeAuthoredFile(path, 'blocked.agent.yaml', 'x', true));
    expect(fault?.message).toBe('cannot write blocked.agent.yaml: the target path is not a file');
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('a failed replacement leaves the old file as it was and no temporary file (an unwritable directory)', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = join(project, '.relavium', 'agents');
    const path = join(dir, 'evil.agent.yaml');
    writeFileSync(path, 'old\n');
    chmodSync(dir, 0o555);
    try {
      expect(() => writeAuthoredFile(path, 'x.yaml', AGENT_CANONICAL, true)).toThrow();
      expect(readFileSync(path, 'utf8'), 'the old bytes survive a failed rewrite').toBe('old\n');
      expect(readdirSync(dir)).toEqual(['evil.agent.yaml']);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('a read-only file is not replaced: the rewrite honours the permission the owner set', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const path = join(project, '.relavium', 'agents', 'evil.agent.yaml');
    writeFileSync(path, 'old\n');
    chmodSync(path, 0o444);
    expect(() => writeAuthoredFile(path, 'x.yaml', AGENT_CANONICAL, true)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('old\n');
    expect(readdirSync(join(project, '.relavium', 'agents'))).toEqual(['evil.agent.yaml']);
  });
});

describe.skipIf(process.platform === 'win32')('an interrupted or raced replacement', () => {
  const agents = (): string => join(project, '.relavium', 'agents');
  const target = (): string => join(agents(), 'evil.agent.yaml');
  const fault = (code: string): Error => Object.assign(new Error(`${code}: boom`), { code });

  it.each([
    ['the flush to disk', () => vi.mocked(fs.fsyncSync)],
    ['the rename over the old file', () => vi.mocked(fs.renameSync)],
  ])(
    'a fault in %s leaves the old file whole, removes the temporary and lets the fault propagate',
    (_name, spy) => {
      writeFileSync(target(), 'old\n');
      spy().mockImplementationOnce(() => {
        throw fault('ENOSPC');
      });
      expect(() => writeAuthoredFile(target(), 'x.yaml', AGENT_CANONICAL, true)).toThrow(/ENOSPC/);
      expect(readFileSync(target(), 'utf8'), 'the old bytes are whole, not truncated').toBe(
        'old\n',
      );
      expect(readdirSync(agents()), 'no temporary file is left').toEqual(['evil.agent.yaml']);
    },
  );

  it('a name that was taken between the look and the create is replaced if it is a plain file', () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      // The exclusive create loses a race: the other writer's file is there, and the create fails as `wx` fails.
      fs.writeFileSync(path, 'the other writer\n', options);
      throw fault('EEXIST');
    });
    writeAuthoredFile(target(), 'x.yaml', AGENT_CANONICAL, true);
    expect(readFileSync(target(), 'utf8')).toBe(AGENT_CANONICAL);
    expect(readdirSync(agents())).toEqual(['evil.agent.yaml']);
  });

  it('a name that was taken by a LINK between the look and the create is refused, and the link leads nowhere new', () => {
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, VICTIM);
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      symlinkSync(victim, target());
      throw fault('EEXIST');
    });
    const refused = refusal(() => writeAuthoredFile(target(), 'x.yaml', AGENT_CANONICAL, true));
    expect(refused?.message).toBe(NOT_PLAIN);
    expect(readFileSync(victim, 'utf8')).toBe(VICTIM);
    expect(lstatSync(target()).isSymbolicLink()).toBe(true);
  });

  it('a link swapped in AFTER the look is replaced by the rename, never written through', () => {
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, VICTIM);
    writeFileSync(target(), 'old\n');
    // The moment between the look (a regular file) and the rename: the file becomes a link to the victim.
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      rmSync(target());
      symlinkSync(victim, target());
    });
    writeAuthoredFile(target(), 'x.yaml', AGENT_CANONICAL, true);
    expect(readFileSync(victim, 'utf8'), 'the victim is untouched').toBe(VICTIM);
    expect(lstatSync(target()).isFile(), 'the name now holds the new regular file').toBe(true);
    expect(readFileSync(target(), 'utf8')).toBe(AGENT_CANONICAL);
  });
});

/** Whether a FIFO can be made here (POSIX with `mkfifo`). */
const canMakeFifo = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'relavium-fifo-probe-'));
  try {
    execFileSync('mkfifo', [join(probe, 'f')], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe.skipIf(!canMakeFifo)('a FIFO at the target is refused at once, never opened', () => {
  it(
    'with --force: the fixed sentence, the FIFO still there, and no wait for a writer',
    { timeout: 4000 },
    () => {
      const path = join(project, '.relavium', 'agents', 'pipe.agent.yaml');
      execFileSync('mkfifo', [path]);
      // A helper opens the FIFO's write end after a second: an open of the FIFO would be held until then, and the elapsed time fails.
      writer = spawn('sh', ['-c', 'sleep 1; exec 3>"$1"; sleep 2', 'sh', path], {
        stdio: 'ignore',
      });
      const started = Date.now();
      const fault = refusal(() =>
        writeAuthoredFile(path, 'pipe.agent.yaml', AGENT_CANONICAL, true),
      );
      expect(fault?.message).toBe(NOT_PLAIN);
      expect(Date.now() - started, 'the refusal did not wait for a writer').toBeLessThan(800);
      expect(lstatSync(path).isFIFO(), 'the FIFO was not replaced by a file').toBe(true);
    },
  );
});
