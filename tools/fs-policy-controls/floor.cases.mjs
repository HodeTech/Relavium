import { Buffer } from 'node:buffer';
/** Native additional floor witnesses; loaded only by isolated causal control runs. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFilesystemMediaWrite, FilesystemMediaStore } from '@relavium/db';
import { createNodeFsCapability } from '../../apps/cli/src/engine/tool-host/fs.js';
import { createMentionReader } from '../../apps/cli/src/render/tui/mention.js';
const state = vi.hoisted(() => ({
  fixedUUID: false,
  readdir: vi.fn(),
  open: vi.fn(),
  mkdir: vi.fn(),
  realpath: vi.fn(),
}));
vi.mock('node:crypto', async (original) => {
  const native = await original();
  return {
    ...native,
    randomUUID: () =>
      state.fixedUUID ? '00000000-0000-4000-8000-000000000000' : native.randomUUID(),
  };
});
vi.mock('node:fs/promises', async (original) => {
  const native = await original();
  return {
    ...native,
    readdir: (...args) => {
      state.readdir(args[0]);
      return native.readdir(...args);
    },
    open: (...args) => {
      state.open(args[0]);
      return native.open(...args);
    },
    mkdir: (...args) => {
      state.mkdir(args[0]);
      return native.mkdir(...args);
    },
    realpath: (...args) => {
      state.realpath(args[0]);
      return native.realpath(...args);
    },
  };
});
let root;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-fs-floor-control-')));
  state.fixedUUID = false;
  for (const key of ['readdir', 'open', 'mkdir', 'realpath']) state[key].mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function refuse(operation, marker) {
  let error;
  try {
    await operation;
  } catch (failure) {
    error = failure;
  }
  expect(error, marker).toBeInstanceOf(Error);
}
const dirPaths = [
  '.kube/config',
  '.azure/tokens',
  '.terraform.d/token',
  'gcloud/configurations/config_default',
  'legacy_credentials/token',
];
const basePaths = ['application_default_credentials.json', 'credentials.tfrc.json'];
for (const [kind, paths] of [
  ['DIR', dirPaths],
  ['BASENAME', basePaths],
]) {
  it.each(paths)(`FS_CAUSAL_CREDENTIAL_${kind} %s`, async (path) => {
    const secret = join(root, path);
    mkdirSync(dirname(secret), { recursive: true });
    writeFileSync(secret, 'synthetic-private');
    writeFileSync(join(root, 'safe.txt'), 'safe');
    const host = createNodeFsCapability({ tier: 'full', workspaceDir: root, readOnly: false });
    await refuse(host.readFile(path, {}), `FS_CAUSAL_CREDENTIAL_${kind}`);
    await refuse(host.writeFile(path, 'replace', {}), `FS_CAUSAL_CREDENTIAL_${kind}`);
    await refuse(createMentionReader(host).read(path), `FS_CAUSAL_CREDENTIAL_${kind}`);
    const listing = await host.listDirectory('.', { recursive: true });
    expect(
      listing.entries.map((entry) => entry.name),
      `FS_CAUSAL_CREDENTIAL_${kind}`,
    ).not.toContain(path);
    expect(
      (await host.readFile('**/*', { glob: true })).content,
      `FS_CAUSAL_CREDENTIAL_${kind}`,
    ).not.toContain('synthetic-private');
    if (kind === 'DIR')
      expect(
        state.readdir.mock.calls.map(([p]) => String(p)),
        `FS_CAUSAL_CREDENTIAL_${kind}`,
      ).not.toContain(dirname(secret));
    expect(
      state.open.mock.calls.map(([p]) => String(p)),
      `FS_CAUSAL_CREDENTIAL_${kind}`,
    ).not.toContain(secret);
    if (kind === 'DIR') {
      symlinkSync(dirname(secret), join(root, 'innocent'), 'junction');
      await refuse(
        host.readFile(join('innocent', path.split('/').at(-1)), {}),
        `FS_CAUSAL_CREDENTIAL_${kind}`,
      );
    }
    expect(readFileSync(secret, 'utf8')).toBe('synthetic-private');
  });
}
it('FS_CAUSAL_SAVE_DRIVE_PREFIX', async () => {
  await refuse(
    createFilesystemMediaWrite(root)('C:relative.txt', Buffer.from('x')),
    'FS_CAUSAL_SAVE_DRIVE_PREFIX',
  );
  expect(state.realpath, 'FS_CAUSAL_SAVE_DRIVE_PREFIX').not.toHaveBeenCalled();
  expect(state.mkdir, 'FS_CAUSAL_SAVE_DRIVE_PREFIX').not.toHaveBeenCalled();
});
it('FS_CAUSAL_CAS_EXCLUSIVE_TEMP', async () => {
  state.fixedUUID = true;
  const temp = join(root, 'stream.00000000-0000-4000-8000-000000000000.tmp');
  writeFileSync(temp, 'unowned');
  await refuse(
    new FilesystemMediaStore(root).put(Buffer.from('replacement')),
    'FS_CAUSAL_CAS_EXCLUSIVE_TEMP',
  );
  expect(readFileSync(temp, 'utf8'), 'FS_CAUSAL_CAS_EXCLUSIVE_TEMP').toBe('unowned');
});
