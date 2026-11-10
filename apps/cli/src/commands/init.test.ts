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
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../run.js';
import { captureIo } from '../test-support.js';

describe('explicit init command', () => {
  let root: string, home: string, cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-init-command-'));
    home = join(root, 'home');
    cwd = join(home, 'project');
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const argv = (...args: string[]) => ['node', 'relavium', '--cwd', cwd, 'init', ...args];

  it.each([false, true])(
    'creates only its advertised directories, without global state or prompts (json=%s)',
    async (json) => {
      const captured = captureIo();
      expect(await run(argv(...(json ? ['--json'] : [])), captured.io)).toBe(0);
      expect(captured.err()).toBe('');
      expect(readdirSync(home)).toEqual(['project']);
      expect(readdirSync(cwd)).toEqual(['.relavium']);
      expect(readdirSync(join(cwd, '.relavium')).sort()).toEqual(['agents', 'workflows']);
      if (json) {
        const result: unknown = JSON.parse(captured.out());
        expect(result).toEqual({
          status: 'created',
          path: '.relavium',
          created: ['.relavium', join('.relavium', 'workflows'), join('.relavium', 'agents')],
        });
        expect(captured.out().trimEnd().split('\n')).toHaveLength(1);
      } else
        expect(captured.out().trimEnd().split('\n')).toEqual([
          'Created .relavium',
          `Created ${join('.relavium', 'workflows')}`,
          `Created ${join('.relavium', 'agents')}`,
        ]);
    },
  );

  it('reports an existing ancestor without nesting or repairing its marker', async () => {
    const marker = join(cwd, '.relavium');
    mkdirSync(marker);
    writeFileSync(join(marker, 'sentinel'), 'keep');
    const nested = join(cwd, 'src', 'nested');
    mkdirSync(nested, { recursive: true });
    const captured = captureIo();
    expect(await run(['node', 'relavium', '--cwd', nested, 'init', '--json'], captured.io)).toBe(0);
    const result: unknown = JSON.parse(captured.out());
    expect(result).toEqual({
      status: 'already-initialized',
      path: relative(nested, marker),
      created: [],
    });
    expect(readdirSync(marker)).toEqual(['sentinel']);
    expect(readdirSync(nested)).toEqual([]);
    expect(readFileSync(join(marker, 'sentinel'), 'utf8')).toBe('keep');
  });

  it.each([false, true])(
    'refuses home and a final linked marker without writes (json=%s)',
    async (json) => {
      const atHome = captureIo();
      expect(
        await run(
          ['node', 'relavium', '--cwd', home, 'init', ...(json ? ['--json'] : [])],
          atHome.io,
        ),
      ).toBe(2);
      expect(atHome.err()).toContain('project directory');
      expect(readdirSync(home)).toEqual(['project']);
      const target = join(root, 'target');
      mkdirSync(target);
      symlinkSync(
        target,
        join(cwd, '.relavium'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const linked = captureIo();
      expect(await run(argv(...(json ? ['--json'] : [])), linked.io)).toBe(2);
      expect(linked.err()).toContain('symbolic link');
      expect(linked.out()).toBe('');
      expect(readdirSync(target)).toEqual([]);
    },
  );
});
