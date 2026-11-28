/**
 * The Home's own `@` reader (ADR-0061 on the Home's two prompts) is the chat's: `scopedMentionReader` is the one factory both use, the
 * READ-ONLY filesystem capability over the invocation's policy. Proved here on a real temporary workspace with the refusal corpus of the
 * filesystem floor's own tests (`engine/tool-host/fs-policy.test.ts`'s credential stores, the `.ssh`/`.aws`/`.env` class): every credential
 * store is left out of the listing and refused by a read, a symbolic link that leaves the workspace is refused, a binary file and a file over
 * the read ceiling are refused, and an ordinary file is read. The lazy reader the Home holds builds the capability on first use only, and a
 * failed build is a rejection the picker turns into "nothing listed" and "could not read".
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFsPathPolicy } from '../engine/tool-host/fs-policy.js';
import type { MentionReader } from '../render/tui/mention.js';
import { lazyMentionReader, scopedMentionReader } from './mention-reader.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The credential stores the floor refuses (the chat's corpus: `.ssh`, `.aws`, `.env`-class, and the fs-policy test's own list). */
const CREDENTIAL_PATHS = [
  '.ssh/id_rsa',
  '.aws/credentials',
  '.env',
  '.env.local',
  '.npmrc',
  '.git-credentials',
  '.kube/config',
  '.azure/accessTokens.json',
  '.config/gcloud/configurations/config_default',
  '.terraform.d/credentials.tfrc.json',
] as const;
/** The top-level names of those stores: none is ever offered by the picker's listing. */
const CREDENTIAL_NAMES = [
  '.ssh',
  '.aws',
  '.env',
  '.env.local',
  '.npmrc',
  '.git-credentials',
  '.kube',
  '.azure',
  '.terraform.d',
];

function workspace() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-home-mention-')));
  roots.push(root);
  const home = join(root, 'operator');
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(home);
  mkdirSync(project);
  mkdirSync(outside);
  for (const path of CREDENTIAL_PATHS) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), 'synthetic-credential');
  }
  writeFileSync(join(outside, 'secret.txt'), 'outside the workspace');
  symlinkSync(join(outside, 'secret.txt'), join(project, 'link.txt'));
  writeFileSync(join(project, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
  writeFileSync(join(project, 'huge.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  writeFileSync(join(project, 'ok.txt'), 'an ordinary file');
  const reader = scopedMentionReader({
    operatorHomeDir: home,
    fsScopeTier: 'sandboxed',
    workspaceDir: project,
    fsPolicy: createFsPathPolicy({ workspaceDir: project }),
  });
  if (reader === undefined) throw new Error('no filesystem arm');
  return { reader, project };
}

describe('the Home’s reader holds the chat’s floor', () => {
  it('lists an ordinary file and leaves every credential store out of the listing', async () => {
    const { reader } = workspace();
    const names = (await reader.list('')).map((candidate) => candidate.name);
    expect(names).toContain('ok.txt');
    for (const name of CREDENTIAL_NAMES) expect(names, name).not.toContain(name);
  });

  it.each(CREDENTIAL_PATHS)('refuses to read the credential store %s', async (path) => {
    const { reader } = workspace();
    await expect(reader.read(path)).rejects.toThrow();
  });

  it('refuses a symbolic link that leaves the workspace, a binary file and a file over the read ceiling; reads an ordinary one', async () => {
    const { reader } = workspace();
    await expect(reader.read('link.txt')).rejects.toThrow();
    await expect(reader.read('blob.bin')).rejects.toThrow();
    await expect(reader.read('huge.txt')).rejects.toThrow();
    await expect(reader.read('ok.txt')).resolves.toMatchObject({ content: 'an ordinary file' });
  });

  it('never climbs out of the workspace: a path above it is refused', async () => {
    const { reader } = workspace();
    await expect(reader.read('../outside/secret.txt')).rejects.toThrow();
  });
});

describe('the lazy reader the Home holds', () => {
  it('builds nothing until the first listing, then builds once', async () => {
    const inner: MentionReader = {
      list: vi.fn(() => Promise.resolve([])),
      read: vi.fn(() => Promise.resolve({ content: '', sizeBytes: 0 })),
    };
    const build = vi.fn(() => inner);
    const lazy = lazyMentionReader(build);
    expect(build).not.toHaveBeenCalled();
    await lazy.list('');
    await lazy.read('a');
    await lazy.list('src');
    expect(build).toHaveBeenCalledOnce();
  });

  it('a build that fails, or no filesystem arm, is a rejection of the call that asked, and the next call tries again', async () => {
    const build = vi
      .fn<() => MentionReader | undefined>()
      .mockImplementationOnce(() => {
        throw new Error('policy refused');
      })
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => ({
        list: () => Promise.resolve([]),
        read: () => Promise.resolve({ content: 'x', sizeBytes: 1 }),
      }));
    const lazy = lazyMentionReader(build);
    await expect(lazy.list('')).rejects.toThrow('policy refused');
    await expect(lazy.read('a')).rejects.toThrow();
    await expect(lazy.read('a')).resolves.toMatchObject({ content: 'x' });
  });
});
