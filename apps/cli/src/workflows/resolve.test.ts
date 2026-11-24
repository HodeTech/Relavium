import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_SOURCE_CHARS, parseWorkflow, parseAgent } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { BARE_ID_WITHOUT_HOME, resolveYamlSource, resolveWorkflowSource } from './resolve.js';

// The file operations are wrapped (calling through to the real ones) so a test can see which of them were used, and can act between two of
// them, the way another process would.
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    statSync: vi.fn(native.statSync),
    readFileSync: vi.fn(native.readFileSync),
    openSync: vi.fn(native.openSync),
    fstatSync: vi.fn(native.fstatSync),
    readSync: vi.fn(native.readSync),
  };
});

const YAML = 'schema_version: "1.0"\n';

let root: string;
// The operator home a bare id is admitted against: a fresh directory, never the real one (it is a required argument).
let home: string;
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.clearAllMocks();
  // clearAllMocks keeps the call-through implementations; make that explicit for the ones a test replaces.
  vi.mocked(statSync).mockImplementation(native.statSync);
  vi.mocked(openSync).mockImplementation(native.openSync);
  vi.mocked(fstatSync).mockImplementation(native.fstatSync);
  vi.mocked(readSync).mockImplementation(native.readSync);
  root = mkdtempSync(join(tmpdir(), 'relavium-resolve-'));
  home = mkdtempSync(join(tmpdir(), 'relavium-resolve-home-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('resolveWorkflowSource', () => {
  it('reads an explicit absolute path', () => {
    const path = join(root, 'flow.relavium.yaml');
    writeFileSync(path, YAML);
    const src = resolveWorkflowSource(path, {
      cwd: root,
      homeDir: home,
      projectConfigDir: undefined,
    });
    expect(src).toEqual({ path, yaml: YAML });
  });

  it('reads an explicit relative path against the cwd', () => {
    writeFileSync(join(root, 'flow.yaml'), YAML);
    const src = resolveWorkflowSource('./flow.yaml', {
      cwd: root,
      homeDir: home,
      projectConfigDir: undefined,
    });
    expect(src.path).toBe(join(root, 'flow.yaml'));
    expect(src.yaml).toBe(YAML);
  });

  it('resolves a bare id under <projectConfigDir>/workflows/<id>.relavium.yaml', () => {
    const dir = join(root, '.relavium', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'greet.relavium.yaml'), YAML);
    const src = resolveWorkflowSource('greet', {
      cwd: root,
      homeDir: home,
      projectConfigDir: join(root, '.relavium'),
    });
    expect(src.path).toBe(join(dir, 'greet.relavium.yaml'));
  });

  it('falls back to the bare <id>.yaml form', () => {
    const dir = join(root, '.relavium', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'greet.yaml'), YAML);
    const src = resolveWorkflowSource('greet', {
      cwd: root,
      homeDir: home,
      projectConfigDir: join(root, '.relavium'),
    });
    expect(src.path).toBe(join(dir, 'greet.yaml'));
  });

  it('throws a clean exit-2 miss listing the candidate paths', () => {
    let caught: unknown;
    try {
      resolveWorkflowSource('absent', {
        cwd: root,
        homeDir: home,
        projectConfigDir: join(root, '.relavium'),
      });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('absent.relavium.yaml');
    }
  });

  it('reports no project when a bare id is given without a project config dir', () => {
    let caught: unknown;
    try {
      resolveWorkflowSource('absent', { cwd: root, homeDir: home, projectConfigDir: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.message).toContain('no project');
  });

  it('refuses a bare id when the caller holds no operator home, before reading anything', () => {
    // A bare id is admitted against the operator home; with none it is refused, never judged by the process's own home.
    const dir = join(root, '.relavium', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'greet.relavium.yaml'), YAML);
    vi.mocked(readFileSync).mockClear();
    let caught: unknown;
    try {
      resolveYamlSource('greet', {
        cwd: root,
        homeDir: undefined,
        kind: 'workflow',
        subdir: 'workflows',
        projectConfigDir: join(root, '.relavium'),
        idSuffixes: ['.relavium.yaml'],
      });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('internal');
      expect(caught.message).toBe(BARE_ID_WITHOUT_HOME);
      expect(caught.message).not.toContain(root);
    }
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('still reads an explicit path when the caller holds no operator home: a path is not admitted against it', () => {
    const path = join(root, 'flow.relavium.yaml');
    writeFileSync(path, YAML);
    expect(
      resolveYamlSource(path, {
        cwd: root,
        homeDir: undefined,
        kind: 'workflow',
        subdir: 'workflows',
        projectConfigDir: undefined,
        idSuffixes: ['.relavium.yaml'],
      }),
    ).toEqual({ path, yaml: YAML });
  });

  it('rejects an existing path that is not a regular file (a directory) rather than reporting "not found"', () => {
    const dir = join(root, 'flow.relavium.yaml');
    mkdirSync(dir); // a directory where a workflow file was named
    let caught: unknown;
    try {
      resolveWorkflowSource(dir, { cwd: root, homeDir: home, projectConfigDir: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('workflow'); // the `kind` is substituted into the diagnostic
      expect(caught.message).toContain('not a regular file');
      expect(caught.message).not.toContain('not found'); // the EACCES/EISDIR-as-miss bug regression guard
    }
  });

  it.each(['workflow', 'agent'] as const)(
    'refuses a %s file that is not valid UTF-8 instead of running it with U+FFFD in place of the bad bytes (review P05-2)',
    (kind) => {
      const path = join(root, `bad-${kind}.yaml`);
      writeFileSync(
        path,
        Buffer.concat([
          Buffer.from('id: bad\nmodel: m\nsystem_prompt: "pay '),
          Buffer.from([0xff, 0xfe]),
          Buffer.from(' never"\n'),
        ]),
      );
      let caught: unknown;
      try {
        resolveYamlSource(path, {
          cwd: root,
          homeDir: home,
          kind,
          subdir: kind,
          projectConfigDir: undefined,
          idSuffixes: ['.yaml'],
        });
      } catch (err) {
        caught = err;
      }
      expect(isCliError(caught)).toBe(true);
      if (isCliError(caught)) {
        expect(caught.code).toBe('invalid_invocation');
        expect(caught.message).toBe(`${kind} file 'bad-${kind}.yaml' is not valid UTF-8.`);
        expect(caught.message).not.toContain(root);
      }
    },
  );

  it('still reads well-formed multibyte text and keeps a leading byte-order mark', () => {
    const path = join(root, 'wide.yaml');
    writeFileSync(path, `\uFEFFid: wide\nname: 日本語 €\n`);
    const source = resolveYamlSource(path, {
      cwd: root,
      homeDir: home,
      kind: 'agent',
      subdir: 'agent',
      projectConfigDir: undefined,
      idSuffixes: ['.yaml'],
    });
    expect(source.yaml).toBe('\uFEFFid: wide\nname: 日本語 €\n');
  });

  it('rejects a workflow file over the size cap before reading it', () => {
    const path = join(root, 'huge.relavium.yaml');
    writeFileSync(path, 'a'.repeat(MAX_SOURCE_CHARS * 4 + 1)); // above the actual byte ceiling
    let caught: unknown;
    try {
      resolveWorkflowSource(path, { cwd: root, homeDir: home, projectConfigDir: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('workflow'); // the `kind` is substituted into the diagnostic
      expect(caught.message).toContain('size limit');
    }
  });
  it.each(['workflow', 'agent'] as const)(
    'accepts dense UTF-8 %s source above the old byte ceiling, then parses it',
    (kind) => {
      const header =
        kind === 'workflow'
          ? 'schema_version: "1.0"\nworkflow:\n  id: dense\n  nodes: [{id: a, type: input}, {id: b, type: output}]\n  edges: [{from: a, to: b}]\n'
          : 'id: dense\nmodel: gpt-4o\nprovider: openai\nsystem_prompt: hello\n';
      const yaml = `${header}#${'文'.repeat(Math.floor(MAX_SOURCE_CHARS / 2))}\n`;
      expect(yaml.length).toBeLessThan(MAX_SOURCE_CHARS);
      expect(Buffer.byteLength(yaml)).toBeGreaterThan(MAX_SOURCE_CHARS);
      const path = join(root, `${kind}.yaml`);
      writeFileSync(path, yaml);
      const source = resolveYamlSource(path, {
        cwd: root,
        homeDir: home,
        kind,
        subdir: kind,
        projectConfigDir: undefined,
        idSuffixes: ['.yaml'],
      });
      expect(
        kind === 'workflow' ? parseWorkflow(source.yaml).workflow.id : parseAgent(source.yaml).id,
      ).toBe('dense');
    },
  );

  it('leaves the authoritative ASCII character overflow to the parser', () => {
    const path = join(root, 'long.yaml');
    writeFileSync(path, `#${'a'.repeat(MAX_SOURCE_CHARS)}`);
    const source = resolveWorkflowSource(path, {
      cwd: root,
      homeDir: home,
      projectConfigDir: undefined,
    });
    expect(() => parseWorkflow(source.yaml)).toThrow(/limit/i);
  });

  it('refuses true byte overflow before any file read', () => {
    const path = join(root, 'huge.yaml');
    writeFileSync(path, 'a'.repeat(MAX_SOURCE_CHARS * 4 + 1));
    expect(() =>
      resolveWorkflowSource(path, { cwd: root, homeDir: home, projectConfigDir: undefined }),
    ).toThrow(/size limit/);
    expect(openSync).not.toHaveBeenCalled(); // refused from the stat: the file was never opened, let alone read
  });

  it.each(['stat', 'open', 'read'] as const)(
    'keeps a native %s fault as cause without disclosing its absolute path',
    (stage) => {
      const path = join(root, 'fault.yaml');
      writeFileSync(path, YAML);
      const cause = Object.assign(new Error(`private native path: ${path}`), { code: 'EACCES' });
      const fail = (): never => {
        throw cause;
      };
      if (stage === 'stat') vi.mocked(statSync).mockImplementationOnce(fail);
      else if (stage === 'open') vi.mocked(openSync).mockImplementationOnce(fail);
      else vi.mocked(readSync).mockImplementationOnce(fail);
      try {
        resolveWorkflowSource(path, { cwd: root, homeDir: home, projectConfigDir: undefined });
        expect.fail('native fault must refuse');
      } catch (error) {
        expect(isCliError(error)).toBe(true);
        if (!isCliError(error)) throw error;
        expect(error.cause).toBe(cause);
        expect(error.message).toBe(`workflow file 'fault.yaml' could not be read.`);
        expect(error.message).not.toContain(root);
        expect(error.message).not.toContain('private native');
      }
    },
  );

  describe('reads through ONE descriptor, opened only after the stat has admitted a regular file (review: stat then read by path)', () => {
    const resolveAt = (path: string) =>
      resolveWorkflowSource(path, { cwd: root, homeDir: home, projectConfigDir: undefined });
    const POSIX = process.platform !== 'win32';

    it('stats the path first, opens it once without blocking, and reads through the descriptor', () => {
      const path = join(root, 'one.relavium.yaml');
      writeFileSync(path, YAML);
      expect(resolveAt(path).yaml).toBe(YAML);

      const statAt = vi.mocked(statSync).mock.calls.findIndex(([target]) => target === path);
      const opens = vi.mocked(openSync).mock.calls.filter(([target]) => target === path);
      expect(statAt).toBeGreaterThanOrEqual(0);
      expect(opens).toHaveLength(1);
      expect(vi.mocked(statSync).mock.invocationCallOrder[statAt]).toBeLessThan(
        vi.mocked(openSync).mock.invocationCallOrder[0] ?? 0,
      );
      const flags = Number(opens[0]?.[1]);
      for (const flag of [constants.O_NONBLOCK, constants.O_NOCTTY]) {
        if (flag !== undefined) expect(flags & flag).toBe(flag);
      }
      expect(vi.mocked(readSync).mock.calls.length).toBeGreaterThan(0);
      expect(vi.mocked(readFileSync)).not.toHaveBeenCalledWith(path);
    });

    it.skipIf(!POSIX)(
      'never opens a directory, a FIFO or a device: each is refused at the stat',
      () => {
        const directory = join(root, 'a-directory');
        mkdirSync(directory);
        const fifo = join(root, 'a-fifo');
        execFileSync('mkfifo', [fifo]);
        for (const target of [directory, fifo, '/dev/null']) {
          expect(() => resolveAt(target), target).toThrow(/is not a regular file\.$/u);
        }
        expect(vi.mocked(openSync).mock.calls.map(([target]) => target)).toEqual([]);
      },
    );

    it('reads the file it opened, not one renamed over the path after the open', async () => {
      const native = await vi.importActual<typeof import('node:fs')>('node:fs');
      const path = join(root, 'swap.relavium.yaml');
      writeFileSync(path, YAML);
      const other = join(root, 'other.yaml');
      writeFileSync(other, 'schema_version: "other"\n');
      let swapped = false;
      vi.mocked(openSync).mockImplementation((target, flags, mode) => {
        const fd = native.openSync(target, flags, mode);
        if (target === path && !swapped) {
          swapped = true;
          renameSync(other, path);
        }
        return fd;
      });
      expect(resolveAt(path).yaml).toBe(YAML);
      expect(swapped).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('other'); // the swap really happened
    });

    it('refuses a different file swapped in between the stat and the open, unread', async () => {
      const native = await vi.importActual<typeof import('node:fs')>('node:fs');
      const path = join(root, 'swap.relavium.yaml');
      writeFileSync(path, YAML);
      const other = join(root, 'other.yaml');
      writeFileSync(other, 'schema_version: "other"\n');
      let swapped = false;
      vi.mocked(statSync).mockImplementation((target, options) => {
        const stats = native.statSync(target, options);
        if (target === path && !swapped) {
          swapped = true;
          renameSync(other, path);
        }
        return stats;
      });
      expect(() => resolveAt(path)).toThrow(
        "workflow file 'swap.relavium.yaml' could not be read.",
      );
      expect(swapped).toBe(true);
      expect(vi.mocked(readSync)).not.toHaveBeenCalled();
    });

    it.skipIf(!POSIX)(
      'refuses a FIFO swapped in between the stat and the open, without waiting for it',
      async () => {
        const native = await vi.importActual<typeof import('node:fs')>('node:fs');
        const path = join(root, 'swap.relavium.yaml');
        writeFileSync(path, YAML);
        const fifo = join(root, 'swap-fifo');
        execFileSync('mkfifo', [fifo]);
        // A reader and a writer are held, so that an open that forgot O_NONBLOCK (the flags test above catches that) could not hang the test
        // worker: a blocked synchronous open cannot be timed out.
        const reader = native.openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
        const writer = native.openSync(fifo, constants.O_WRONLY);
        let swapped = false;
        vi.mocked(statSync).mockImplementation((target, options) => {
          const stats = native.statSync(target, options);
          if (target === path && !swapped) {
            swapped = true;
            renameSync(fifo, path);
          }
          return stats;
        });
        try {
          expect(() => resolveAt(path)).toThrow(
            "workflow file 'swap.relavium.yaml' could not be read.",
          );
          expect(swapped).toBe(true);
        } finally {
          closeSync(writer);
          closeSync(reader);
        }
      },
    );

    it('refuses a file that grew past the cap after its size was read, from the bytes it reads', async () => {
      const native = await vi.importActual<typeof import('node:fs')>('node:fs');
      const path = join(root, 'grow.relavium.yaml');
      writeFileSync(path, YAML);
      let grown = false;
      vi.mocked(fstatSync).mockImplementation((fd, options) => {
        const stats = native.fstatSync(fd, options);
        if (!grown) {
          grown = true;
          appendFileSync(path, Buffer.alloc(MAX_SOURCE_CHARS * 4, 0x20)); // after the size was taken, before the read
        }
        return stats;
      });
      expect(() => resolveAt(path)).toThrow(
        `workflow file 'grow.relavium.yaml' exceeds the ${String(MAX_SOURCE_CHARS * 4)}-byte size limit.`,
      );
      expect(grown).toBe(true);
    });
  });

  it('labels both the absolute argument and searched candidates in a miss', () => {
    const path = join(root, 'missing.yaml');
    try {
      resolveWorkflowSource(path, { cwd: root, homeDir: home, projectConfigDir: undefined });
      expect.fail('missing source must refuse');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      if (!isCliError(error)) throw error;
      expect(error.message).toContain('missing.yaml');
      expect(error.message).not.toContain(root);
    }
  });
});
