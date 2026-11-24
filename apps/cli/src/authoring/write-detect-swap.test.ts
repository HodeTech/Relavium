/**
 * A swap that outruns the pin is DETECTED (the second security sitting on PR #102, finding 1). The pin (`pinDirectory`) looks at the
 * directory before the temporary is created and again before the rename, which narrows the window and does not close it: a second
 * principal who can write to `.relavium/` and exchanges `.relavium/agents` with a link to a victim directory (`renamex_np` with
 * `RENAME_SWAP`, run in a loop) can have the link in place when the temporary is created, the real directory back when the pin looks,
 * and the link again at the rename, so the temporary is created and renamed INSIDE the victim directory and replaces
 * `victim/evil.agent.yaml`. Node has no `openat` or `renameat` on a directory descriptor, so the replacement cannot be prevented from
 * here. What can be done, and is: the temporary's identity is taken before the rename; the temporary must still be where its name says
 * right before the rename; and after the rename the name must hold that same file and the directory must still be the approved one. A
 * mismatch is reported in fixed words (the file may have been written elsewhere), so the person knows to look.
 *
 * The probe's interleaving is made deterministic by wrapping the calls the write makes (`vi.mock` of `node:fs`), and the directory is
 * flipped between the real one and the link at chosen steps. What these cases prove is the DETECTION; they assert, too, what the swap
 * did that detection cannot undo (the victim's file is the new one), so nothing here claims a prevention.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commitImport, prepareImport } from '../commands/import.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    lstatSync: vi.fn(actual.lstatSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const ELSEWHERE =
  'The file may have been written to another directory, because the target directory was changed by something else while it was being written. Check where it went, then retry.';

const AGENT = `id: evil
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const AGENT_CANONICAL =
  'id: evil\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n';

let root = '';
let project = '';
let home = '';
let outside = '';
/** Whether `.relavium/agents` is, right now, the link to `outside` (and the real directory is aside). */
let linked = false;

beforeEach(() => {
  for (const spy of [fs.accessSync, fs.fsyncSync, fs.lstatSync, fs.renameSync]) {
    vi.mocked(spy).mockReset();
  }
  linked = false;
  root = mkdtempSync(join(tmpdir(), 'relavium-detect-swap-'));
  project = join(root, 'project');
  home = join(root, 'home');
  outside = join(root, 'outside');
  for (const dir of [project, home, outside]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
  writeFileSync(join(project, '.relavium', 'agents', 'evil.agent.yaml'), 'old\n');
  writeFileSync(join(outside, 'evil.agent.yaml'), 'VICTIM-ORIGINAL\n');
  writeFileSync(join(project, 'incoming.agent.yaml'), AGENT);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const agents = (): string => join(project, '.relavium', 'agents');
const moved = (): string => join(project, '.relavium', 'agents-moved');

/** The directory becomes the link to `outside` (the real one moves aside). A no-op when it already is. */
function toLink(): void {
  if (linked) return;
  realFs.renameSync(agents(), moved());
  realFs.symlinkSync(outside, agents());
  linked = true;
}
/** The directory becomes the real one again. A no-op when it already is. */
function toReal(): void {
  if (!linked) return;
  realFs.unlinkSync(agents());
  realFs.renameSync(moved(), agents());
  linked = false;
}

const plan = () =>
  prepareImport(
    { path: 'incoming.agent.yaml', force: true },
    {
      global: {
        json: false,
        color: false,
        cwd: project,
        configPath: undefined,
        verbosity: 'normal',
      } satisfies GlobalOptions,
      homeDir: home,
    },
  );

function messageOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    return cause.message;
  }
}

/** The names under `dir` that are temporaries of a forced write. */
const temporariesIn = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.startsWith('.relavium-write-'));

/** Whether a path is the temporary the write created (its name is the write's own, whatever directory it is looked for in). */
const isTemporary = (path: unknown): boolean =>
  typeof path === 'string' && /\.relavium-write-[0-9a-f-]+\.tmp$/u.test(path);

/**
 * The probe's interleaving, step by step. `link` after the permission check makes the temporary land in the victim directory; `real` after
 * the flush shows the pin the approved directory; `link` in the look at the temporary (it is found there) and so at the rename, which then
 * happens inside the victim directory. What each case does AFTER the rename is its own.
 */
function interleaveLikeTheProbe(afterRename: () => void): void {
  vi.mocked(fs.accessSync).mockImplementationOnce((path, mode) => {
    fs.accessSync(path, mode);
    toLink();
  });
  vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
    fs.fsyncSync(fd);
    toReal();
  });
  vi.mocked(fs.lstatSync).mockImplementation(((path: unknown, options: unknown) => {
    // The look at the temporary right before the rename: the link is back for it, and stays for the rename.
    if (isTemporary(path)) toLink();
    return (realFs.lstatSync as (p: unknown, o: unknown) => unknown)(path, options);
  }) as never);
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    toLink();
    fs.renameSync(from, to);
    afterRename();
  });
}

describe.skipIf(process.platform === 'win32')('a swap that outruns the pin', () => {
  it('is reported when the link is still there after the rename: the victim’s file was replaced, and the write says so', () => {
    interleaveLikeTheProbe(() => undefined);
    const message = messageOf(() => commitImport(plan()));
    // What detection cannot undo: the rename happened inside the victim directory.
    expect(readFileSync(join(outside, 'evil.agent.yaml'), 'utf8')).toBe(AGENT_CANONICAL);
    expect(message).toBe(ELSEWHERE);
    toReal();
    expect(temporariesIn(outside), 'no temporary is left in the victim directory').toEqual([]);
    expect(temporariesIn(agents()), 'nor in the project').toEqual([]);
  });

  it('is reported when the real directory is back after the rename: the name holds another file than the one written', () => {
    interleaveLikeTheProbe(() => {
      toReal();
    });
    const message = messageOf(() => commitImport(plan()));
    expect(readFileSync(join(outside, 'evil.agent.yaml'), 'utf8')).toBe(AGENT_CANONICAL);
    expect(message).toBe(ELSEWHERE);
    expect(
      readFileSync(join(agents(), 'evil.agent.yaml'), 'utf8'),
      'the project’s file is as it was',
    ).toBe('old\n');
    expect(temporariesIn(outside)).toEqual([]);
    expect(temporariesIn(agents())).toEqual([]);
  });

  it('is reported BEFORE the rename when the temporary is not where its name says: the victim’s file is not touched', () => {
    // The link is in place when the temporary is created and gone when the pin and the look at the temporary run: the temporary is in the
    // victim directory, and the rename would have been inside it.
    vi.mocked(fs.accessSync).mockImplementationOnce((path, mode) => {
      fs.accessSync(path, mode);
      toLink();
    });
    vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => {
      fs.fsyncSync(fd);
      toReal();
    });
    const message = messageOf(() => commitImport(plan()));
    expect(message).toBe(ELSEWHERE);
    expect(
      readFileSync(join(outside, 'evil.agent.yaml'), 'utf8'),
      'the victim’s file is whole',
    ).toBe('VICTIM-ORIGINAL\n');
    expect(readFileSync(join(agents(), 'evil.agent.yaml'), 'utf8')).toBe('old\n');
    expect(vi.mocked(fs.renameSync).mock.calls.length, 'the rename was never attempted').toBe(0);
    // What cleanup by name cannot reach: the temporary is in the victim directory, and the name no longer leads there.
    expect(temporariesIn(outside)).toHaveLength(1);
    expect(temporariesIn(agents())).toEqual([]);
  });

  it('with the link still in place when the temporary is found missing from the pin’s directory, the temporary is removed by the canonical path', () => {
    // The link is in place for the whole write: the pin refuses it before the rename, and the cleanup, which uses the same canonical
    // path as the creation, takes the temporary out of the directory the link points at.
    vi.mocked(fs.accessSync).mockImplementationOnce((path, mode) => {
      fs.accessSync(path, mode);
      toLink();
    });
    const message = messageOf(() => commitImport(plan()));
    expect(message).toBe(
      'The target directory was changed by something else while the file was being written, so nothing was written. Retry.',
    );
    expect(temporariesIn(outside), 'removed from the victim directory').toEqual([]);
    expect(readFileSync(join(outside, 'evil.agent.yaml'), 'utf8')).toBe('VICTIM-ORIGINAL\n');
  });
});
