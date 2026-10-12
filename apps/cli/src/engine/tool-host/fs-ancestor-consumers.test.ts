import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createFilesystemMediaWrite } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNodeFsCapability } from './fs.js';

const injected = vi.hoisted(
  (): {
    failure: { path: string; code: string } | undefined;
    mkdir: ReturnType<typeof vi.fn>;
  } => ({ failure: undefined, mkdir: vi.fn() }),
);
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    realpath: (...args: Parameters<typeof native.realpath>) => {
      if (injected.failure !== undefined && relative(String(args[0]), injected.failure.path) === '')
        return Promise.reject(
          Object.assign(new Error('private-path-sentinel'), { code: injected.failure.code }),
        );
      return native.realpath(...args);
    },
    mkdir: (...args: Parameters<typeof native.mkdir>) => {
      injected.mkdir(args[0]);
      return native.mkdir(...args);
    },
  };
});

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-ancestor-consumers-')));
  injected.failure = undefined;
  injected.mkdir.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(['tool', 'save_to'] as const)(
  'shared ancestor through actual %s port',
  (consumer) => {
    function write(path: string): Promise<unknown> {
      return consumer === 'tool'
        ? createNodeFsCapability({
            tier: 'sandboxed',
            workspaceDir: root,
            readOnly: false,
          }).writeFile(path, 'synthetic', { createDirs: true })
        : createFilesystemMediaWrite(root)(path, Buffer.from('synthetic'));
    }
    it.each(['EACCES', 'ELOOP', 'ENOTDIR', 'EIO'])(
      '%s refuses before any mkdir and never echoes the native failure',
      async (code) => {
        injected.failure = { path: join(root, 'not-yet-created', 'child'), code };
        await expect(write('not-yet-created/child/a.txt')).rejects.not.toThrow(
          /private-path-sentinel/,
        );
        expect(injected.mkdir).not.toHaveBeenCalled();
        expect(existsSync(join(root, 'not-yet-created'))).toBe(false);
      },
    );
    it('refuses an existing dangling ancestor rather than treating its ENOENT as absence', async () => {
      symlinkSync(join(root, 'missing-target'), join(root, 'dangling'), 'junction');
      await expect(write('dangling/child/a.txt')).rejects.toThrow();
      expect(injected.mkdir).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'missing-target'))).toBe(false);
    });
    it('refuses an actual non-directory ancestor before creating anything', async () => {
      writeFileSync(join(root, 'file'), 'ordinary');
      await expect(write('file/child/a.txt')).rejects.toThrow();
      expect(injected.mkdir).not.toHaveBeenCalled();
    });
    it('climbs genuine missing descendants and preserves different persistence/tool authorities', async () => {
      await write('new/deep/a.txt');
      expect(existsSync(join(root, 'new', 'deep', 'a.txt'))).toBe(true);
      injected.mkdir.mockClear();
      if (consumer === 'tool') {
        await expect(write('.relavium/runs/a.txt')).rejects.toThrow(/protected/);
        expect(injected.mkdir).not.toHaveBeenCalled();
      } else {
        mkdirSync(join(root, '.relavium'));
        await write('.relavium/runs/a.txt');
        expect(existsSync(join(root, '.relavium', 'runs', 'a.txt'))).toBe(true);
      }
    });
  },
);
