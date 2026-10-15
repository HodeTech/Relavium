import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FsCapability, FsScopeTier } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assembleToolEnv } from './assemble.js';
import { createNodeFsCapability } from './fs.js';
import {
  admitInvocationFsGrants,
  createFsPathPolicy,
  FsPolicyError,
  issueHostScratchRoot,
  selectInvocationFsPolicy,
  type FsPathPolicy,
  type HostScratchRoot,
} from './fs-policy.js';

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
let selected: string;
let home: string;
let scratch: string;
let descriptor: HostScratchRoot;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-scratch-composition-')));
  workspace = join(base, 'workspace');
  grant = join(base, 'grant');
  selected = join(grant, 'selected');
  home = join(base, 'home');
  scratch = join(home, '.relavium', 'tmp', 'parent');
  mkdirSync(workspace);
  mkdirSync(selected, { recursive: true });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'ok.txt'), 'workspace');
  writeFileSync(join(grant, 'ok.txt'), 'grant');
  writeFileSync(join(selected, 'in.txt'), 'selected');
  writeFileSync(join(scratch, 'artifact.txt'), 'artifact');
  descriptor = issueHostScratchRoot({ homeDir: home, rootDir: scratch });
  observed.open.mockClear();
  observed.readdir.mockClear();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function assembled(
  policy: FsPathPolicy,
  tier: FsScopeTier = 'project',
  attachment: HostScratchRoot = descriptor,
  workspaceDir = workspace,
): FsCapability {
  const fs = assembleToolEnv({
    profile: 'chat-read-write',
    fsScopeTier: tier,
    workspaceDir,
    fsPolicy: policy,
    scratch: attachment,
  }).host.fs;
  if (fs === undefined) throw new Error('fixture requires the filesystem arm');
  return fs;
}

function admitted(selectors: readonly string[] | undefined = undefined): FsPathPolicy {
  return selectInvocationFsPolicy(admitInvocationFsGrants([grant]), workspace, selectors);
}

describe.each(['sandboxed', 'project'] as const)('scratch plus policy in %s', (tier) => {
  it.each(['absent', 'empty', 'narrow'] as const)(
    'preserves %s selectors while enabling exact scratch through the shared factory',
    async (selection) => {
      const selectors =
        selection === 'absent' ? undefined : selection === 'empty' ? [] : [selected];
      const policy = admitted(selectors);
      const fs = assembled(policy, tier);
      expect((await fs.readFile('ok.txt', {})).content).toBe('workspace');
      const [scratchResult] = await Promise.allSettled([
        fs.readFile(join(scratch, 'artifact.txt'), {}),
      ]);
      expect(scratchResult, 'FS_SCRATCH_POLICY_COMPOSED').toMatchObject({
        status: 'fulfilled',
        value: { content: 'artifact' },
      });
      expect((await fs.listDirectory(scratch, {})).entries.map((entry) => entry.name)).toContain(
        'artifact.txt',
      );
      expect((await fs.readFile(join(scratch, '*.txt'), { glob: true })).content).toContain(
        'artifact',
      );
      await fs.writeFile(join(scratch, 'nested', 'new.txt'), 'scratch update', {
        createDirs: true,
      });
      expect((await fs.readFile(join(scratch, 'nested', 'new.txt'), {})).content).toBe(
        'scratch update',
      );
      if (tier === 'project' && selection !== 'empty') {
        expect((await fs.readFile(join(selected, 'in.txt'), {})).content).toBe('selected');
        await fs.writeFile(join(selected, 'new.txt'), 'grant update', {});
        expect((await fs.readFile(join(selected, 'new.txt'), {})).content).toBe('grant update');
      } else {
        await expect(fs.readFile(join(selected, 'in.txt'), {})).rejects.toThrow(/scope/);
        await expect(fs.writeFile(join(selected, 'new.txt'), 'no', {})).rejects.toThrow(/scope/);
      }
      if (tier === 'project' && selection === 'absent') {
        expect((await fs.readFile('../grant/ok.txt', {})).content).toBe('grant');
      } else {
        await expect(fs.readFile('../grant/ok.txt', {})).rejects.toThrow(/scope/);
      }
      // Composition must not mutate the original policy and grant it scratch retroactively.
      const original = createNodeFsCapability({
        tier,
        workspaceDir: workspace,
        readOnly: false,
        pathPolicy: policy,
      });
      await expect(original.readFile(join(scratch, 'artifact.txt'), {})).rejects.toThrow(
        /credential/,
      );
    },
  );

  it('retains home, project, sibling, nested-credential and symlink floors', async () => {
    const fs = assembled(admitted(), tier);
    writeFileSync(join(home, '.relavium', 'config.toml'), 'home credential');
    mkdirSync(`${scratch}-sibling`, { mode: 0o700 });
    writeFileSync(`${scratch}-sibling/other.txt`, 'sibling');
    const paths = [
      join(home, '.relavium', 'config.toml'),
      join(workspace, '.relavium', 'config.toml'),
      join(scratch, '.kube', 'config'),
      join(scratch, '.relavium', 'history.db'),
      `${scratch}-sibling/other.txt`,
    ];
    for (const path of paths) {
      await expect(fs.readFile(path, {})).rejects.toThrow();
      await expect(fs.writeFile(path, 'denied', { createDirs: true })).rejects.toThrow();
    }
    expect(existsSync(join(scratch, '.kube'))).toBe(false);
    expect(readFileSync(join(home, '.relavium', 'config.toml'), 'utf8')).toBe('home credential');
    symlinkSync(selected, join(scratch, 'linked'), 'junction');
    await expect(fs.readFile(join(scratch, 'linked', 'in.txt'), {})).rejects.toThrow();
    expect(
      (await fs.listDirectory(scratch, { recursive: true })).entries.map((entry) => entry.name),
    ).not.toContain('linked/in.txt');
    expect((await fs.readFile(join(scratch, 'artifact.txt'), {})).content).toBe('artifact');
  });
});

it('reattaches the same scratch descriptor and preserves an already attached policy when omitted', async () => {
  const policy = createFsPathPolicy({
    workspaceDir: workspace,
    extraRoots: [grant],
    scratch: descriptor,
  });
  const attached = assembled(policy);
  const retained = createNodeFsCapability({
    tier: 'project',
    workspaceDir: workspace,
    readOnly: false,
    pathPolicy: policy,
  });
  for (const fs of [attached, retained]) {
    expect((await fs.readFile(join(scratch, 'artifact.txt'), {})).content).toBe('artifact');
    expect((await fs.readFile('../grant/ok.txt', {})).content).toBe('grant');
  }
});

it('refuses forged policy or scratch descriptors without granting access to existing roots', async () => {
  const policy = admitted();
  for (const fs of [
    assembled(policy, 'project', { kind: 'host-scratch-root' }),
    assembled({ kind: 'owned-fs-policy' }),
  ]) {
    await expect(fs.readFile('ok.txt', {})).rejects.toThrow(FsPolicyError);
    await expect(fs.writeFile('new.txt', 'denied', {})).rejects.toThrow(FsPolicyError);
    await expect(fs.listDirectory('.', {})).rejects.toThrow(FsPolicyError);
  }
  expect(observed.open).not.toHaveBeenCalled();
  expect(observed.readdir).not.toHaveBeenCalled();
});

it.each(['same-root-new-descriptor', 'different-root'] as const)(
  'refuses conflicting scratch attachment: %s',
  async (kind) => {
    const policy = createFsPathPolicy({ workspaceDir: workspace, scratch: descriptor });
    const secondRoot = kind === 'different-root' ? `${scratch}-second` : scratch;
    if (kind === 'different-root') mkdirSync(secondRoot, { mode: 0o700 });
    const second = issueHostScratchRoot({ homeDir: home, rootDir: secondRoot });
    const fs = assembled(policy, 'project', second);
    await expect(fs.readFile('ok.txt', {})).rejects.toThrow(FsPolicyError);
    expect(observed.open).not.toHaveBeenCalled();
  },
);

it('keeps opaque policy authority when extraRoots strings are also supplied', async () => {
  const ungranted = join(base, 'ungranted');
  mkdirSync(ungranted);
  writeFileSync(join(ungranted, 'outside.txt'), 'outside');
  const fs = createNodeFsCapability({
    tier: 'project',
    workspaceDir: workspace,
    readOnly: false,
    pathPolicy: admitted([]),
    scratch: descriptor,
    extraRoots: [ungranted, grant],
  });
  expect((await fs.readFile('ok.txt', {})).content).toBe('workspace');
  expect((await fs.readFile(join(scratch, 'artifact.txt'), {})).content).toBe('artifact');
  await expect(fs.readFile(join(ungranted, 'outside.txt'), {})).rejects.toThrow(/scope/);
  await expect(fs.readFile('../grant/ok.txt', {})).rejects.toThrow(/scope/);
});

describe.each(['before-composition', 'after-composition'] as const)(
  '%s identity revocation',
  (stage) => {
    it.each(['workspace', 'grant', 'selector', 'scratch', 'anchor'] as const)(
      'retains and revalidates the original %s pin',
      async (kind) => {
        const policy = admitted([selected]);
        const prior = stage === 'after-composition' ? assembled(policy) : undefined;
        if (prior !== undefined)
          expect((await prior.readFile('ok.txt', {})).content).toBe('workspace');
        const target =
          kind === 'workspace'
            ? workspace
            : kind === 'grant'
              ? grant
              : kind === 'selector'
                ? selected
                : kind === 'scratch'
                  ? scratch
                  : join(home, '.relavium');
        renameSync(target, `${target}-old`);
        mkdirSync(target, { mode: 0o700 });
        const fs = prior ?? assembled(policy);
        observed.open.mockClear();
        observed.readdir.mockClear();
        await expect(fs.readFile('ok.txt', {})).rejects.toThrow(FsPolicyError);
        await expect(fs.writeFile('new.txt', 'denied', {})).rejects.toThrow(FsPolicyError);
        await expect(fs.listDirectory('.', {})).rejects.toThrow(FsPolicyError);
        expect(observed.open).not.toHaveBeenCalled();
        expect(observed.readdir).not.toHaveBeenCalled();
      },
    );

    it('retains even an unselected invocation grant when selectors are empty', async () => {
      const policy = admitted([]);
      const prior = stage === 'after-composition' ? assembled(policy) : undefined;
      renameSync(grant, `${grant}-old`);
      mkdirSync(grant);
      const fs = prior ?? assembled(policy);
      await expect(fs.readFile('ok.txt', {})).rejects.toThrow(FsPolicyError);
      expect(observed.open).not.toHaveBeenCalled();
    });

    it('retains a lexical grant alias separately from its unchanged selected target', async () => {
      const alias = join(base, 'grant-alias');
      symlinkSync(grant, alias, 'junction');
      const policy = selectInvocationFsPolicy(admitInvocationFsGrants([alias]), workspace, [
        selected,
      ]);
      const prior = stage === 'after-composition' ? assembled(policy) : undefined;
      renameSync(alias, `${alias}-old`);
      symlinkSync(grant, alias, 'junction');
      const fs = prior ?? assembled(policy);
      await expect(fs.readFile(join(selected, 'in.txt'), {})).rejects.toThrow(FsPolicyError);
      expect(observed.open).not.toHaveBeenCalled();
    });
  },
);

it.each(['workspace', 'grant', 'selector'] as const)(
  'composition preserves lexical credential provenance of the original %s',
  async (kind) => {
    const alias = join(
      base,
      kind === 'workspace' ? '.relavium' : kind === 'grant' ? '.azure' : '.kube',
    );
    symlinkSync(grant, alias, 'junction');
    const policy =
      kind === 'workspace'
        ? createFsPathPolicy({ workspaceDir: alias })
        : selectInvocationFsPolicy(
            admitInvocationFsGrants([kind === 'grant' ? alias : base]),
            workspace,
            kind === 'selector' ? [alias] : undefined,
          );
    const fs = assembled(policy, 'project', descriptor, kind === 'workspace' ? grant : workspace);
    const target = join(grant, 'ok.txt');
    await expect(fs.readFile(target, {})).rejects.toThrow(/credential/);
    await expect(fs.writeFile(target, 'denied', {})).rejects.toThrow(/protected|credential/);
    await expect(fs.listDirectory(grant, { recursive: true })).rejects.toThrow(/credential/);
    await expect(fs.readFile(join(grant, '*.txt'), { glob: true })).rejects.toThrow(/credential/);
    expect(observed.open).not.toHaveBeenCalled();
    expect(observed.readdir).not.toHaveBeenCalled();
    expect(readFileSync(target, 'utf8')).toBe('grant');
    expect((await fs.readFile(join(scratch, 'artifact.txt'), {})).content).toBe('artifact');
  },
);

it.runIf(process.platform !== 'win32')(
  'revokes composed scratch when its private modes change',
  async () => {
    const fs = assembled(admitted());
    expect((await fs.readFile(join(scratch, 'artifact.txt'), {})).content).toBe('artifact');
    chmodSync(dirname(scratch), 0o755);
    await expect(fs.readFile('ok.txt', {})).rejects.toThrow(FsPolicyError);
  },
);
