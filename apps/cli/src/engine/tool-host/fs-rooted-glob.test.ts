import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import type { FsCapability, FsScopeTier } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assembleToolEnv } from './assemble.js';
import { FsPolicyError, admitInvocationFsGrants, selectInvocationFsPolicy } from './fs-policy.js';

const observed = vi.hoisted(() => ({ open: vi.fn(), readdir: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: (...args: Parameters<typeof native.open>) => {
      observed.open(args[0]);
      return native.open(...args);
    },
    readdir: (...args: Parameters<typeof native.readdir>) => {
      observed.readdir(args[0]);
      return native.readdir(...args);
    },
  };
});

let base: string;
let workspace: string;
let grant: string;
let nested: string;
let outside: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-rooted-glob-')));
  workspace = join(base, 'workspace');
  grant = join(base, 'grant');
  nested = join(grant, 'nested');
  outside = join(base, 'outside');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, 'ok.txt'), 'workspace text');
  writeFileSync(join(workspace, 'src', 'in1.txt'), 'workspace nested');
  writeFileSync(join(grant, 'ok.txt'), 'grant text');
  writeFileSync(join(nested, 'in1.txt'), 'grant nested');
  writeFileSync(join(outside, 'outside.txt'), 'outside sentinel');
  observed.open.mockClear();
  observed.readdir.mockClear();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function capability(tier: FsScopeTier = 'project', selectors?: readonly string[]): FsCapability {
  const fs = assembleToolEnv({
    profile: 'chat-read-write',
    fsScopeTier: tier,
    workspaceDir: workspace,
    fsPolicy: selectInvocationFsPolicy(admitInvocationFsGrants([grant]), workspace, selectors),
  }).host.fs;
  if (fs === undefined) throw new Error('fixture requires the filesystem arm');
  return fs;
}

it.each([
  { name: 'workspace basename', target: 'workspace', path: 'ok.txt', content: 'workspace text' },
  {
    name: 'workspace relative parent',
    target: 'workspace',
    path: 'src/in1.txt',
    content: 'workspace nested',
  },
  { name: 'extra-root relative parent', target: 'grant', path: 'ok.txt', content: 'grant text' },
  {
    name: 'extra-root nested parent',
    target: 'grant',
    path: 'nested/in1.txt',
    content: 'grant nested',
  },
] as const)(
  'reads a literal glob at $name and returns a reusable file path',
  async ({ target, path, content }) => {
    const fs = capability();
    const absolute = join(target === 'workspace' ? workspace : grant, path);
    const relativePath = relative(workspace, absolute).split(sep).join('/');
    for (const pattern of [relativePath, absolute]) {
      const [outcome] = await Promise.allSettled([fs.readFile(pattern, { glob: true })]);
      expect(outcome, 'FS_ROOTED_LITERAL_GLOB_ADMITTED').toMatchObject({
        status: 'fulfilled',
      });
      if (outcome?.status !== 'fulfilled') throw new Error('fixture requires admitted glob');
      const result = outcome.value;
      expect(result.content).toContain(content);
      expect(result.content).toContain(relative(workspace, absolute));
      expect((await fs.readFile(relativePath, {})).content).toBe(content);
    }
  },
);

it.each([
  '../grant/*.txt',
  '../grant/nest*/in?.txt',
  '../grant/**/in?.txt',
  '../grant/**/ok.txt',
  '../grant/nested/in?.txt',
])('retains wildcard matching and root authority: %s', async (pattern) => {
  const fs = capability();
  const result = await fs.readFile(pattern, { glob: true });
  expect(result.content).toContain(pattern.includes('in?') ? 'grant nested' : 'grant text');
  expect(result.content).not.toContain('outside sentinel');
  expect((await fs.readFile(join(grant, '**', '*.txt'), { glob: true })).content).toContain(
    'grant nested',
  );
});

it('admits literal and wildcard paths within a narrowed selected directory only', async () => {
  const fs = capability('project', [nested]);
  for (const pattern of [
    '../grant/nested/in1.txt',
    join(nested, 'in1.txt'),
    '../grant/nested/*.txt',
  ]) {
    expect((await fs.readFile(pattern, { glob: true })).content).toContain('grant nested');
  }
  for (const pattern of ['../grant/ok.txt', join(grant, 'ok.txt'), '../grant/*.txt']) {
    await expect(fs.readFile(pattern, { glob: true })).rejects.toThrow(/scope/);
  }
});

describe.each(['sandboxed', 'project'] as const)('literal glob scope in %s', (tier) => {
  it('does not widen empty selectors or permit an outside directory', async () => {
    const fs = capability(tier, []);
    for (const pattern of [
      '../grant/ok.txt',
      join(grant, 'ok.txt'),
      '../grant/*.txt',
      '../outside/outside.txt',
      join(outside, 'outside.txt'),
      '../outside/*.txt',
    ]) {
      await expect(fs.readFile(pattern, { glob: true })).rejects.toThrow(/scope/);
    }
    expect(observed.open).not.toHaveBeenCalled();
    expect(observed.readdir).not.toHaveBeenCalled();
    expect((await fs.readFile('src/in1.txt', { glob: true })).content).toContain(
      'workspace nested',
    );
  });
});

it('sandboxed still ignores invocation extra roots with absent selectors', async () => {
  const fs = capability('sandboxed');
  await expect(fs.readFile('../grant/ok.txt', { glob: true })).rejects.toThrow(/scope/);
  expect((await fs.readFile('ok.txt', { glob: true })).content).toContain('workspace text');
});

it('rejects an outside symlinked parent and omits an outside symlinked match', async () => {
  symlinkSync(outside, join(grant, 'escape'), 'junction');
  symlinkSync(join(outside, 'outside.txt'), join(grant, 'escape.txt'), 'file');
  const fs = capability();
  for (const pattern of ['../grant/escape/outside.txt', '../grant/escape/*.txt']) {
    await expect(fs.readFile(pattern, { glob: true })).rejects.toThrow(/scope/);
  }
  await expect(fs.readFile('../grant/escape.txt', { glob: true })).rejects.toThrow(/no files/);
  expect((await fs.readFile('../grant/*.txt', { glob: true })).content).toContain('grant text');
  expect(observed.open.mock.calls.map(([path]) => String(path))).not.toContain(
    join(outside, 'outside.txt'),
  );
  expect(observed.readdir.mock.calls.map(([path]) => String(path))).not.toContain(outside);
});

it('preserves lexical and canonical credential floors with literal and wildcard roots', async () => {
  const sensitive = join(grant, '.kube');
  mkdirSync(sensitive);
  writeFileSync(join(sensitive, 'config'), 'credential sentinel');
  writeFileSync(join(grant, '.env'), 'dotenv sentinel');
  symlinkSync(sensitive, join(grant, 'innocent'), 'junction');
  symlinkSync(nested, join(grant, '.azure'), 'junction');
  const fs = capability();
  for (const pattern of [
    '../grant/.kube/config',
    '../grant/.kube/*',
    '../grant/innocent/config',
    '../grant/innocent/*',
    '../grant/.azure/in1.txt',
    '../grant/.azure/*',
    '../grant/.env',
    join(grant, '.env'),
  ]) {
    await expect(fs.readFile(pattern, { glob: true })).rejects.toThrow();
  }
  expect(observed.open).not.toHaveBeenCalled();
  expect(observed.readdir.mock.calls.map(([path]) => String(path))).not.toContain(sensitive);
  const broad = await fs.readFile('../grant/**/*', { glob: true });
  expect(broad.content).toContain('grant text');
  expect(broad.content).toContain('grant nested');
  expect(broad.content).not.toContain('sentinel');
});

it('revalidates pinned grants before literal glob enumeration', async () => {
  const fs = capability();
  renameSync(grant, `${grant}-old`);
  mkdirSync(grant);
  writeFileSync(join(grant, 'ok.txt'), 'replacement');
  await expect(fs.readFile('../grant/ok.txt', { glob: true })).rejects.toThrow(FsPolicyError);
  expect(observed.open).not.toHaveBeenCalled();
  expect(observed.readdir).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')(
  'accepts native absolute backslashes for literal and wildcard globs',
  async () => {
    const fs = capability();
    for (const pattern of [join(grant, 'ok.txt'), join(grant, '*.txt')]) {
      expect((await fs.readFile(pattern, { glob: true })).content).toContain('grant text');
    }
  },
);
