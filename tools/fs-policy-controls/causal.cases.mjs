import { Buffer } from 'node:buffer';
/** ADR-0105 bounded causal witnesses. Collected only by the isolated control runner. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
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
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFilesystemMediaWrite, FilesystemMediaStore } from '@relavium/db';
import { isForbiddenDeclaredEnvKey, McpServerRefSchema } from '@relavium/shared';
import { createNodeFsCapability } from '../../apps/cli/src/engine/tool-host/fs.js';
import {
  admitInvocationFsGrants,
  createFsPathPolicy,
  issueHostScratchRoot,
  selectInvocationFsPolicy,
} from '../../apps/cli/src/engine/tool-host/fs-policy.js';
import { discoverCatalog } from '../../apps/cli/src/workflows/catalog.js';
const observed = vi.hoisted(() => ({
  failure: undefined,
  mkdir: vi.fn(),
  open: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original();
  return {
    ...native,
    realpath: (...args) =>
      String(args[0]) === observed.failure?.path
        ? Promise.reject(
            Object.assign(new Error('private-native-sentinel'), { code: observed.failure.code }),
          )
        : native.realpath(...args),
    mkdir: (...args) => {
      observed.mkdir(args[0]);
      return native.mkdir(...args);
    },
    open: (...args) => {
      observed.open(args[0]);
      return native.open(...args);
    },
  };
});
let base, workspace, outside;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-fs-causal-')));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, 'a.txt'), 'private');
  observed.failure = undefined;
  observed.mkdir.mockClear();
  observed.open.mockClear();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const fs = () =>
  createNodeFsCapability({
    tier: 'project',
    workspaceDir: workspace,
    readOnly: false,
    pathPolicy: selectInvocationFsPolicy(admitInvocationFsGrants([outside]), workspace, undefined),
  });
async function requireRefusal(operation, marker) {
  let error;
  try {
    await operation;
  } catch (failure) {
    error = failure;
  }
  expect(error, marker).toBeInstanceOf(Error);
}
it('FS_CAUSAL_SELECTOR_CEILING', () => {
  expect(
    () => selectInvocationFsPolicy(admitInvocationFsGrants([]), workspace, [outside]),
    'FS_CAUSAL_SELECTOR_CEILING',
  ).toThrow();
});
it('FS_CAUSAL_ROOT_IDENTITY', async () => {
  const host = fs();
  renameSync(outside, outside + '-old');
  mkdirSync(outside);
  writeFileSync(join(outside, 'a.txt'), 'replacement');
  await requireRefusal(host.readFile('../outside/a.txt', {}), 'FS_CAUSAL_ROOT_IDENTITY');
  expect(observed.open).not.toHaveBeenCalled();
});
it('FS_CAUSAL_LEXICAL_PROVENANCE', async () => {
  const alias = join(base, '.azure');
  symlinkSync(outside, alias, 'junction');
  const host = createNodeFsCapability({
    tier: 'project',
    workspaceDir: workspace,
    readOnly: false,
    pathPolicy: selectInvocationFsPolicy(admitInvocationFsGrants([alias]), workspace, undefined),
  });
  await requireRefusal(host.readFile(join(outside, 'a.txt'), {}), 'FS_CAUSAL_LEXICAL_PROVENANCE');
  expect(observed.open).not.toHaveBeenCalled();
});
it('FS_CAUSAL_SCRATCH_EXACT', async () => {
  const home = join(base, 'home'),
    scratch = join(home, '.relavium', 'tmp', 'parent');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  writeFileSync(join(scratch, 'safe.txt'), 'safe');
  const host = createNodeFsCapability({
    tier: 'sandboxed',
    workspaceDir: workspace,
    readOnly: false,
    pathPolicy: createFsPathPolicy({
      workspaceDir: workspace,
      scratch: issueHostScratchRoot({ homeDir: home, rootDir: scratch }),
    }),
  });
  expect((await host.readFile(join(scratch, 'safe.txt'), {})).content).toBe('safe');
  await requireRefusal(
    host.writeFile(join(scratch, '.relavium', 'history.db'), 'private', { createDirs: true }),
    'FS_CAUSAL_SCRATCH_EXACT',
  );
  expect(existsSync(join(scratch, '.relavium'))).toBe(false);
});
it.each([
  'KUBECONFIG',
  'AWS_DEFAULT_PROFILE',
  'DOCKER_CONFIG',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'TF_CLI_CONFIG_FILE',
])('FS_CAUSAL_ENV %s', (key) => {
  expect(isForbiddenDeclaredEnvKey(key), 'FS_CAUSAL_ENV').toBe(true);
  expect(
    McpServerRefSchema.safeParse({
      id: 'fs',
      transport: 'stdio',
      command: 'node',
      env: { [key]: 'synthetic' },
    }).success,
    'FS_CAUSAL_ENV',
  ).toBe(false);
});
it.each(['tool', 'save_to'])('FS_CAUSAL_ANCESTOR_ERROR %s', async (port) => {
  observed.failure = { path: join(workspace, 'new', 'deep'), code: 'EACCES' };
  const write =
    port === 'tool'
      ? () => fs().writeFile('new/deep/a.txt', 'x', { createDirs: true })
      : () => createFilesystemMediaWrite(workspace)('new/deep/a.txt', Buffer.from('x'));
  await requireRefusal(write(), 'FS_CAUSAL_ANCESTOR_ERROR');
  expect(observed.mkdir, 'FS_CAUSAL_ANCESTOR_ERROR').not.toHaveBeenCalled();
});
it.each(['tool', 'save_to'])('FS_CAUSAL_ANCESTOR_CLIMB %s', async (port) => {
  const write =
    port === 'tool'
      ? () => fs().writeFile('new/deep/a.txt', 'x', { createDirs: true })
      : () => createFilesystemMediaWrite(workspace)('new/deep/a.txt', Buffer.from('x'));
  let failure;
  try {
    await write();
  } catch (error) {
    failure = error;
  }
  expect(failure, 'FS_CAUSAL_ANCESTOR_CLIMB').toBeUndefined();
  expect(readFileSync(join(workspace, 'new/deep/a.txt'), 'utf8')).toBe('x');
});
// Explicit even L16 samples are the structural-only PCM arm. These bytes retain
// the physical CAS identity/path witness without claiming a fabricated file format.
const bytes = Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]);
const digest = createHash('sha256').update(bytes).digest('hex'),
  handle = `media://sha256-${digest}`;
it.each(['shard', 'final', 'hardlink'])('FS_CAUSAL_CAS %s', async (shape) => {
  const root = join(base, 'cas'),
    shard = join(root, digest.slice(0, 2)),
    sibling = join(outside, digest.slice(2));
  mkdirSync(root);
  writeFileSync(sibling, bytes);
  if (shape === 'shard') symlinkSync(outside, shard, 'junction');
  else {
    mkdirSync(shard);
    if (shape === 'final') symlinkSync(sibling, join(shard, digest.slice(2)));
    else linkSync(sibling, join(shard, digest.slice(2)));
  }
  const store = new FilesystemMediaStore(root);
  await requireRefusal(store.delete(handle), 'FS_CAUSAL_CAS_' + shape);
  expect(readFileSync(sibling)).toEqual(bytes);
});
it('FS_CAUSAL_CAS_ROOT_PIN', async () => {
  const root = join(base, 'cas'),
    store = new FilesystemMediaStore(root);
  await store.put(bytes, 'audio/L16');
  renameSync(root, root + '-old');
  mkdirSync(root);
  await requireRefusal(store.put(bytes, 'audio/L16'), 'FS_CAUSAL_CAS_ROOT_PIN');
});
it('FS_CAUSAL_CATALOG_DIRECTORY', () => {
  const project = join(workspace, '.relavium');
  mkdirSync(project);
  symlinkSync(outside, join(project, 'workflows'), 'junction');
  expect(
    () => discoverCatalog({ projectConfigDir: project, cwd: workspace, kind: 'workflows' }),
    'FS_CAUSAL_CATALOG_DIRECTORY',
  ).toThrow();
});
it('FS_CAUSAL_CATALOG_FILE', () => {
  const project = join(workspace, '.relavium');
  mkdirSync(join(project, 'workflows'), { recursive: true });
  const source = join(outside, 'workflow.yaml');
  writeFileSync(
    source,
    "schema_version: '1.0'\nworkflow:\n  id: outside\n  nodes:\n    - { id: result, type: output }\n  edges: []\n",
  );
  symlinkSync(source, join(project, 'workflows', 'link.yaml'));
  const entries = discoverCatalog({ projectConfigDir: project, cwd: workspace, kind: 'workflows' });
  expect(entries[0]?.valid, 'FS_CAUSAL_CATALOG_FILE').toBe(false);
  expect(entries[0]?.error, 'FS_CAUSAL_CATALOG_FILE').toBe('outside the project catalog');
});
