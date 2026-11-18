import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS, createInMemoryEffectJournal, createToolRegistry } from '@relavium/core';
import { createNodeFsCapability } from './fs.js';

describe.skipIf(process.platform !== 'darwin')(
  'macOS role-specific prepared metadata (ADR-0127)',
  () => {
    let root: string;
    let home: string;
    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'relavium-macos-host-')));
      await chmod(root, 0o700);
      home = join(root, 'home');
      await mkdir(home, { mode: 0o700 });
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    function fixture() {
      const fs = createNodeFsCapability({
        tier: 'sandboxed',
        workspaceDir: root,
        operatorHomeDir: home,
        readOnly: false,
      });
      const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { fs } });
      const effects = createInMemoryEffectJournal({
        kind: 'run',
        runId: 'r',
        nodeId: 'n',
        attempt: 1,
      });
      const ctx = {
        nodeId: 'n',
        grantedToolIds: new Set(['read_file', 'write_file', 'edit_file']),
        config: {},
        toolPolicy: {},
        fsScope: 'sandboxed' as const,
        gateApproved: false,
        effects,
        effectSlot: 0,
        effectAttempt: { providerAttempt: 1, toolCallId: 'call' },
        readScope: {},
      };
      return { fs, registry, effects, ctx };
    }
    function attribute(path: string, name: string, hex: string): void {
      execFileSync('/usr/bin/xattr', ['-wx', name, hex, path]);
    }
    function names(path: string): string[] {
      return execFileSync('/usr/bin/xattr', [path], { encoding: 'utf8', maxBuffer: 16384 })
        .trim()
        .split('\n')
        .filter(Boolean);
    }

    it.each([
      'user.content#C',
      'user.note#PS',
      'user.note#',
      'user.note#unknown',
      'user.note#C-c',
      'user.note#C#PS',
    ])('refuses unsupported source %s before a durable claim or private stage', async (name) => {
      const f = fixture();
      const path = join(root, 'file');
      await writeFile(path, 'before');
      attribute(path, name, '01020304');
      await expect(
        f.registry.dispatch(
          {
            type: 'tool_call',
            id: 'write',
            name: 'write_file',
            args: { path: 'file', content: 'after' },
          },
          f.ctx,
        ),
      ).rejects.toMatchObject({
        runErrorCode: 'tool_denied',
        retryable: false,
        message:
          'filesystem metadata preparation refused; permissions or unsupported filesystem metadata may prevent this write',
      });
      expect(f.effects.rows()).toEqual([]);
      expect(await readFile(path, 'utf8')).toBe('before');
      expect(await readdir(root)).toEqual(['file', 'home']);
      expect(await readdir(home)).toEqual([]);
    });

    it('keeps parent suffix values as evidence without copying them to a created file', async () => {
      const f = fixture();
      attribute(root, 'user.content#C', '01020304');
      await f.registry.dispatch(
        {
          type: 'tool_call',
          id: 'write',
          name: 'write_file',
          args: { path: 'file', content: 'é🙂' },
        },
        f.ctx,
      );
      expect(await readFile(join(root, 'file'), 'utf8')).toBe('é🙂');
      expect(names(root)).toContain('user.content#C');
      expect(names(join(root, 'file'))).not.toContain('user.content#C');
      expect(f.effects.rows()[0]?.state).toBe('committed');
    });

    it('preserves exact last-used through append and an observed edit with actual host/journal wiring', async () => {
      const f = fixture();
      const path = join(root, 'file');
      await writeFile(path, 'before\n');
      const hex = '0102030405060708090a0b0c0d0e0f10';
      attribute(path, 'com.apple.lastuseddate#PS', hex);
      const readValue = (): string =>
        execFileSync('/usr/bin/xattr', ['-px', 'com.apple.lastuseddate#PS', path], {
          encoding: 'utf8',
        })
          .replace(/\s/gu, '')
          .toLowerCase();
      await f.registry.dispatch(
        {
          type: 'tool_call',
          id: 'append',
          name: 'write_file',
          args: { path: 'file', content: 'é🙂\n', append: true },
        },
        f.ctx,
      );
      // Keep opaque metadata out of assertion diagnostics, including on mismatch.
      const preservedAfterAppend = readValue() === hex;
      expect(preservedAfterAppend).toBe(true);
      const ctx = {
        ...f.ctx,
        effectSlot: 1,
        effectAttempt: { providerAttempt: 1, toolCallId: 'edit' },
      };
      await f.registry.dispatch(
        { type: 'tool_call', id: 'read', name: 'read_file', args: { path: 'file' } },
        ctx,
      );
      f.fs.promoteReadScope?.(ctx.readScope);
      await f.registry.dispatch(
        {
          type: 'tool_call',
          id: 'edit',
          name: 'edit_file',
          args: { path: 'file', old_string: 'before', new_string: 'after' },
        },
        ctx,
      );
      expect(await readFile(path, 'utf8')).toBe('after\né🙂\n');
      const preservedAfterEdit = readValue() === hex;
      expect(preservedAfterEdit).toBe(true);
      expect(f.effects.rows().map((row) => row.state)).toEqual(['committed', 'committed']);
    });
  },
);
