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
import { dirname, join, relative } from 'node:path';

import type { FsScopeTier } from '@relavium/core';
import { FS_ROOT_LIMITS } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMentionReader } from '../../render/tui/mention.js';
import { assembleToolEnv } from './assemble.js';
import { createNodeFsCapability, isSensitiveReadPath, isProtectedPath } from './fs.js';
import {
  admitInvocationFsGrants,
  createFsPathPolicy,
  FsPolicyError,
  issueHostScratchRoot,
  selectInvocationFsPolicy,
  type FsPathPolicy,
} from './fs-policy.js';

const observed = vi.hoisted(() => ({ readdir: vi.fn(), open: vi.fn() }));
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
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-fs-policy-')));
  workspace = join(base, 'workspace');
  grant = join(base, 'grant');
  mkdirSync(workspace);
  mkdirSync(grant);
  writeFileSync(join(workspace, 'ok.txt'), 'workspace');
  writeFileSync(join(grant, 'ok.txt'), 'grant');
  observed.readdir.mockClear();
  observed.open.mockClear();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function capability(policy: FsPathPolicy, tier: FsScopeTier = 'project') {
  return createNodeFsCapability({
    tier,
    workspaceDir: workspace,
    readOnly: false,
    pathPolicy: policy,
  });
}

describe('invocation authority and owned native identities', () => {
  it('distinguishes absent, empty and narrowing selectors without changing the tier', async () => {
    const nested = join(grant, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'in.txt'), 'narrow');
    const roots = admitInvocationFsGrants([grant]);
    const all = capability(selectInvocationFsPolicy(roots, workspace, undefined));
    const none = capability(selectInvocationFsPolicy(roots, workspace, []));
    const narrow = capability(selectInvocationFsPolicy(roots, workspace, ['../grant/nested']));
    expect((await all.readFile('../grant/ok.txt', {})).content).toBe('grant');
    await expect(none.readFile('../grant/ok.txt', {})).rejects.toThrow(/scope/);
    expect((await narrow.readFile('../grant/nested/in.txt', {})).content).toBe('narrow');
    await expect(narrow.readFile('../grant/ok.txt', {})).rejects.toThrow(/scope/);
    await expect(
      capability(selectInvocationFsPolicy(roots, workspace, undefined), 'sandboxed').readFile(
        '../grant/ok.txt',
        {},
      ),
    ).rejects.toThrow(/scope/);
    expect(() => selectInvocationFsPolicy(roots, workspace, [workspace])).toThrow(FsPolicyError);
  });

  it('admits bounded absolute directories only and does not echo rejected values', () => {
    expect(() =>
      admitInvocationFsGrants(Array.from({ length: FS_ROOT_LIMITS.count }, () => grant)),
    ).not.toThrow();
    for (const paths of [
      [...Array.from({ length: FS_ROOT_LIMITS.count + 1 }, () => grant)],
      ['relative'],
      [join(grant, 'missing')],
      [join(grant, 'ok.txt')],
      ['x'.repeat(FS_ROOT_LIMITS.characters + 1)],
    ]) {
      try {
        admitInvocationFsGrants(paths);
        throw new Error('unexpected admission');
      } catch (error) {
        expect(error).toBeInstanceOf(FsPolicyError);
        expect(String(error)).not.toContain(paths[0]);
      }
    }
    expect(() => selectInvocationFsPolicy({ kind: 'invocation-fs-grants' }, workspace, [])).toThrow(
      FsPolicyError,
    );
    expect(() =>
      createFsPathPolicy({ workspaceDir: workspace, scratch: { kind: 'host-scratch-root' } }),
    ).toThrow(FsPolicyError);
  });

  it.each(['directory', 'alias'] as const)(
    'revokes a replaced %s after admission, before the first tool call',
    async (kind) => {
      const root = kind === 'directory' ? grant : join(base, 'alias');
      if (kind === 'alias') symlinkSync(grant, root, 'junction');
      const policy = selectInvocationFsPolicy(
        admitInvocationFsGrants([root]),
        workspace,
        undefined,
      );
      const fs = capability(policy);
      if (kind === 'directory') {
        renameSync(grant, `${grant}-old`);
        mkdirSync(grant);
      } else {
        rmSync(root);
        symlinkSync(workspace, root, 'junction');
      }
      await expect(fs.readFile('../grant/ok.txt', {})).rejects.toThrow(/pinned identities/);
    },
  );

  it('pins workspace and selected-subroot identities and owns caller arrays/config', async () => {
    const roots = [grant];
    const input = {
      tier: 'project' as const,
      workspaceDir: workspace,
      readOnly: true,
      extraRoots: roots,
    };
    const fs = createNodeFsCapability(input);
    roots.length = 0;
    input.readOnly = false;
    expect((await fs.readFile('../grant/ok.txt', {})).content).toBe('grant');
    await expect(fs.writeFile('new.txt', 'denied', {})).rejects.toThrow(/read.only|not available/);
    renameSync(workspace, `${workspace}-old`);
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'ok.txt'), 'replacement');
    await expect(fs.readFile('ok.txt', {})).rejects.toThrow(/pinned identities/);
  });

  it('returns reusable extra-root paths through write, glob and mention without a doubled anchor', async () => {
    const fs = capability(
      selectInvocationFsPolicy(admitInvocationFsGrants([grant]), workspace, undefined),
    );
    const written = await fs.writeFile('../grant/later.txt', 'later', {});
    expect(written.path).toBe(relative(workspace, join(grant, 'later.txt')));
    expect((await fs.readFile(written.path, {})).content).toBe('later');
    expect((await fs.readFile('../grant/*.txt', { glob: true })).content).toContain(
      '../grant/ok.txt',
    );
    const mention = createMentionReader(fs);
    const candidate = (await mention.list('../grant')).find((entry) => entry.name === 'ok.txt');
    expect(candidate?.path).toBe('../grant/ok.txt');
    expect((await mention.read(candidate?.path ?? 'missing')).content).toBe('grant');
  });
});

const credentialPaths = [
  '.kube/config',
  '.azure/accessTokens.json',
  '.config/gcloud/configurations/config_default',
  '.terraform.d/credentials.tfrc.json',
  'application_default_credentials.json',
];
describe.each(['sandboxed', 'project', 'full'] as const)('credential floors in %s', (tier) => {
  it.each(credentialPaths)(
    'refuses read/write/mention and prunes before descending: %s',
    async (path) => {
      const secret = join(workspace, path);
      mkdirSync(dirname(secret), { recursive: true });
      writeFileSync(secret, 'synthetic-credential');
      const fs = capability(createFsPathPolicy({ workspaceDir: workspace }), tier);
      await expect(fs.readFile(path, {})).rejects.toThrow(/credential/);
      await expect(fs.writeFile(path, 'replacement', { createDirs: true })).rejects.toThrow(
        /credential|protected/,
      );
      await expect(createMentionReader(fs).read(path)).rejects.toThrow(/credential/);
      const listing = await fs.listDirectory('.', { recursive: true });
      expect(listing.entries.map((entry) => entry.name)).not.toContain(path);
      expect((await fs.readFile('*.txt', { glob: true })).content).not.toContain(
        'synthetic-credential',
      );
      const descended = observed.readdir.mock.calls.map(([value]) => String(value));
      if (dirname(secret) !== workspace) expect(descended).not.toContain(dirname(secret));
      expect(observed.open.mock.calls.map(([value]) => String(value))).not.toContain(secret);
      expect(readFileSync(secret, 'utf8')).toBe('synthetic-credential');
    },
  );

  it('checks both sensitively named aliases and innocently named canonical targets', async () => {
    const sensitive = join(workspace, '.kube');
    mkdirSync(sensitive);
    writeFileSync(join(sensitive, 'config'), 'private');
    symlinkSync(sensitive, join(workspace, 'innocent'), 'junction');
    symlinkSync(grant, join(workspace, '.azure'), 'junction');
    const fs = capability(
      createFsPathPolicy({ workspaceDir: workspace, extraRoots: [grant] }),
      tier,
    );
    for (const path of ['innocent/config', '.azure/ok.txt']) {
      await expect(fs.readFile(path, {})).rejects.toThrow(/credential/);
      await expect(fs.writeFile(path, 'bad', {})).rejects.toThrow(/credential|protected/);
    }
    expect((await fs.readFile('ok.txt', {})).content).toBe('workspace');
  });
});

describe('exact private host scratch descriptors (no production allocator)', () => {
  it.each(['tmp', 'artifacts'])(
    'permits only the issued %s tree through both jailed factory tiers',
    async (kind) => {
      const home = join(base, 'home');
      const scratch = join(home, '.relavium', kind, 'parent');
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      writeFileSync(join(home, '.relavium', 'config.toml'), 'private-home');
      writeFileSync(join(scratch, 'artifact.txt'), 'artifact');
      const descriptor = issueHostScratchRoot({ homeDir: home, rootDir: scratch });
      for (const tier of ['sandboxed', 'project'] as const) {
        const fs = assembleToolEnv({
          profile: 'chat-read-write',
          fsScopeTier: tier,
          workspaceDir: workspace,
          scratch: descriptor,
        }).host.fs;
        expect(fs).toBeDefined();
        expect((await fs?.readFile(join(scratch, 'artifact.txt'), {}))?.content).toBe('artifact');
        await fs?.writeFile(join(scratch, 'new', 'nested.txt'), 'new', { createDirs: true });
        expect((await fs?.readFile(join(scratch, 'new', 'nested.txt'), {}))?.content).toBe('new');
        for (const target of [
          join(home, '.relavium', 'config.toml'),
          join(scratch, '.kube', 'config'),
          join(scratch, '.relavium', 'history.db'),
          join(workspace, '.relavium', 'project.toml'),
          `${scratch}-sibling/a`,
        ]) {
          await expect(fs?.writeFile(target, 'no', { createDirs: true })).rejects.toThrow();
          expect(existsSync(target)).toBe(target.endsWith('config.toml'));
        }
        symlinkSync(join(scratch, 'artifact.txt'), join(scratch, 'linked.txt'));
        const listed = await fs?.listDirectory(scratch, { recursive: true });
        expect(listed?.entries.some((entry) => entry.name === 'artifact.txt')).toBe(true);
        expect(listed?.entries.some((entry) => entry.name === 'linked.txt')).toBe(false);
        await expect(fs?.readFile(join(scratch, 'linked.txt'), {})).rejects.toThrow();
        rmSync(join(scratch, 'linked.txt'));
      }
      const fs = capability(createFsPathPolicy({ workspaceDir: workspace, scratch: descriptor }));
      renameSync(scratch, `${scratch}-old`);
      mkdirSync(scratch, { mode: 0o700 });
      await expect(fs.readFile(join(scratch, 'artifact.txt'), {})).rejects.toThrow(
        /pinned identities/,
      );
    },
  );

  it('refuses unrelated roots, linked roots and broad POSIX directory permissions', async () => {
    const home = join(base, 'home');
    const scratch = join(home, '.relavium', 'tmp');
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    expect(() => issueHostScratchRoot({ homeDir: home, rootDir: grant })).toThrow(FsPolicyError);
    symlinkSync(scratch, join(home, '.relavium', 'alias'), 'junction');
    expect(() =>
      issueHostScratchRoot({ homeDir: home, rootDir: join(home, '.relavium', 'alias') }),
    ).toThrow(FsPolicyError);
    if (process.platform !== 'win32') {
      const descriptor = issueHostScratchRoot({ homeDir: home, rootDir: scratch });
      const fs = capability(createFsPathPolicy({ workspaceDir: workspace, scratch: descriptor }));
      mkdirSync(join(scratch, 'public'), { mode: 0o755 });
      writeFileSync(join(scratch, 'public', 'a.txt'), 'private');
      await expect(fs.readFile(join(scratch, 'public', 'a.txt'), {})).rejects.toThrow();
      chmodSync(scratch, 0o755);
      await expect(fs.readFile('ok.txt', {})).rejects.toThrow(/pinned identities/);
    }
  });
});

it.each([
  'C:\\users\\me\\.KUBE \\config',
  'C:\\profile\\.azure\\tokens',
  'C:\\profile\\gcloud\\credentials.db',
  'C:\\profile\\.terraform.d\\credentials.tfrc.json',
  'C:\\x\\APPLICATION_DEFAULT_CREDENTIALS.JSON::$DATA',
])('portable credential spelling refuses read and write: %s', (path) => {
  expect(isSensitiveReadPath(path)).toBe(true);
  expect(isProtectedPath(path)).toBe(true);
});

// Canonical session cwd must not erase a sensitive spelling used to grant the root.
it.each(['workspace', 'grant', 'selector'] as const)(
  'retains lexical %s provenance when consumers use canonical paths',
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
    const fs = createNodeFsCapability({
      tier: 'project',
      workspaceDir: kind === 'workspace' ? grant : workspace,
      readOnly: false,
      pathPolicy: policy,
    });
    const target = join(grant, 'ok.txt');
    await expect(fs.readFile(target, {})).rejects.toThrow(/credential/);
    await expect(fs.writeFile(target, 'no', {})).rejects.toThrow(/credential|protected/);
    await expect(fs.listDirectory(grant, { recursive: true })).rejects.toThrow(/credential/);
    await expect(fs.readFile(join(grant, '*.txt'), { glob: true })).rejects.toThrow(/credential/);
    expect(observed.open).not.toHaveBeenCalled();
    expect(observed.readdir).not.toHaveBeenCalled();
    expect(readFileSync(target, 'utf8')).toBe('grant');
  },
);

it('revokes a selected subdirectory replacement even when its enclosing grant is unchanged', async () => {
  const selected = join(grant, 'selected');
  mkdirSync(selected);
  const fs = capability(
    selectInvocationFsPolicy(admitInvocationFsGrants([grant]), workspace, [selected]),
  );
  renameSync(selected, selected + '-old');
  mkdirSync(selected);
  writeFileSync(join(selected, 'a.txt'), 'replacement');
  await expect(fs.readFile(join(selected, 'a.txt'), {})).rejects.toThrow(/pinned identities/);
  expect(observed.open).not.toHaveBeenCalled();
});

it('never repairs a failed construction by later creating the missing workspace', async () => {
  const missing = join(base, 'missing-workspace');
  const fs = createNodeFsCapability({ tier: 'sandboxed', workspaceDir: missing, readOnly: false });
  mkdirSync(missing);
  writeFileSync(join(missing, 'a.txt'), 'later');
  await expect(fs.readFile('a.txt', {})).rejects.toThrow(/pinned identities/);
  expect(observed.open).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')(
  'native Windows glob spelling retains the authorised root',
  async () => {
    const fs = capability(
      selectInvocationFsPolicy(admitInvocationFsGrants([grant]), workspace, undefined),
    );
    expect((await fs.readFile(join(grant, '*.txt'), { glob: true })).content).toContain('grant');
  },
);
