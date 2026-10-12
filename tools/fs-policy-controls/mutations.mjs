/** Each exact single-site removal declares a specific completed semantic assertion witness. */
const policy = 'apps/cli/src/engine/tool-host/fs-policy.ts';
const paths = 'packages/db/src/media-store-paths.ts';
const cases = 'tools/fs-policy-controls/causal.cases.mjs';
const invocation = 'apps/cli/src/commands/fs-invocation.test.ts';
function control(
  id,
  path,
  before,
  after,
  marker = `FS_CAUSAL_${id}`,
  files = [cases],
  target = marker,
) {
  return { id: id.toLowerCase().replaceAll('_', '-'), path, before, after, marker, files, target };
}
export const mutations = [
  control(
    'SELECTOR_CEILING',
    policy,
    'if (!grants.some((grant) => isWithinFsRoot(grant.canonical, pin.canonical)))',
    'if (false)',
  ),
  control(
    'ROOT_IDENTITY',
    policy,
    '[data.workspace, ...data.grants, ...data.extra].forEach(validatePin);',
    'void data.workspace;',
  ),
  control(
    'LEXICAL_PROVENANCE',
    policy,
    'views.add(join(pin.lexical, relative(pin.canonical, path)));',
    'views.add(path);',
  ),
  control('SCRATCH_EXACT', policy, 'relative(anchor, path));', "path.split(sep).at(-1) ?? '');"),
  control(
    'ENV',
    'packages/shared/src/declared-env.ts',
    "  'KUBECONFIG',\n  'AWS_CONFIG_FILE',\n  'AWS_SHARED_CREDENTIALS_FILE',\n  'AWS_PROFILE',\n  'GOOGLE_APPLICATION_CREDENTIALS',\n  'AZURE_CONFIG_DIR',\n  'AZURE_AUTH_LOCATION',\n  'CLOUDSDK_CONFIG',\n  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',\n  'TF_CLI_CONFIG_FILE',",
    '',
  ),
  control(
    'ANCESTOR_ERROR',
    'packages/shared/src/existing-ancestor.ts',
    "if (!ops.isMissing(error)) throw new ExistingAncestorError('unresolvable');",
    'void error;',
  ),
  control(
    'ANCESTOR_CLIMB',
    'packages/shared/src/existing-ancestor.ts',
    'dir = parent;',
    "throw new ExistingAncestorError('no_ancestor');",
  ),
  control(
    'CAS_SHARD',
    paths,
    '!info.isDirectory() ||\n        info.isSymbolicLink() ||\n        realpathSync(dir) !== dir ||\n        !within(root, dir)',
    'false',
    'FS_CAUSAL_CAS_shard',
    [cases],
    'FS_CAUSAL_CAS shard',
  ),
  control(
    'CAS_FINAL',
    paths,
    'if (!info.isFile() || info.isSymbolicLink() || (info.nlink !== 0 && info.nlink !== 1))',
    'if (info.isFile() && info.isSymbolicLink())',
    'FS_CAUSAL_CAS_final',
    [cases],
    'FS_CAUSAL_CAS final',
  ),
  control(
    'CAS_NLINK',
    paths,
    'if (!info.isFile() || info.isSymbolicLink() || (info.nlink !== 0 && info.nlink !== 1))',
    'if (!info.isFile() || info.isSymbolicLink())',
    'FS_CAUSAL_CAS_hardlink',
    [cases],
    'FS_CAUSAL_CAS hardlink',
  ),
  control(
    'CAS_ROOT_PIN',
    paths,
    'pin !== undefined &&\n        (pin.canonical',
    'false &&\n        (pin.canonical',
  ),
  control(
    'CATALOG_DIRECTORY',
    'apps/cli/src/workflows/catalog.ts',
    "if (!isWithinFsRoot(root, realDir)) throw new Error('outside catalog authority');",
    'void root;',
  ),
  control(
    'CATALOG_FILE',
    'apps/cli/src/workflows/catalog.ts',
    'if (!isWithinFsRoot(root, canonical))',
    'if (false)',
  ),
  control(
    'INVOCATION_FORWARD',
    'apps/cli/src/process/options.ts',
    ': { allowFsRoots: Object.freeze([...raw.allowFsRoots]) }',
    ': { allowFsRoots: Object.freeze([]) }',
    'FS_CAUSAL_INVOCATION_FORWARD',
    [invocation],
    'project selector',
  ),
];
mutations.push(
  control(
    'INVOCATION_ADMISSION',
    'apps/cli/src/run.ts',
    'fsGrants: admitFsInvocation(global)',
    'fsGrants: admitFsInvocation({ ...global, allowFsRoots: [] })',
    'FS_CAUSAL_INVOCATION_ADMISSION',
    [invocation],
    'invalid grants refuse',
  ),
  control(
    'RESUME_GRANTS',
    'apps/cli/src/commands/chat.ts',
    'fsPolicy = admitChatFsPolicy(grants, originalCwd, config.chat.extraRoots);',
    'fsPolicy = admitChatFsPolicy(grants, originalCwd, undefined);',
    'FS_CAUSAL_RESUME_GRANTS',
    [invocation],
    'resumed unmatched selectors',
  ),
);

const floorCases = ['tools/fs-policy-controls/floor.cases.mjs'];
mutations.push(
  control(
    'CREDENTIAL_DIR',
    'apps/cli/src/engine/tool-host/fs.ts',
    "  '.kube',\n  '.azure',\n  '.terraform.d',\n  'gcloud', // Unix XDG and Windows APPDATA stores include token databases and credential-bearing configurations.\n  'legacy_credentials',",
    '',
    'FS_CAUSAL_CREDENTIAL_DIR',
    floorCases,
  ),
  control(
    'CREDENTIAL_BASENAME',
    'apps/cli/src/engine/tool-host/fs.ts',
    "  'application_default_credentials.json',\n  'credentials.tfrc.json',",
    '',
    'FS_CAUSAL_CREDENTIAL_BASENAME',
    floorCases,
  ),
  control(
    'SAVE_DRIVE_PREFIX',
    'packages/db/src/media-write.ts',
    '/^[A-Za-z]:/.test(relativePath)',
    String.raw`/^[A-Za-z]:[\\/]/.test(relativePath)`,
    'FS_CAUSAL_SAVE_DRIVE_PREFIX',
    floorCases,
  ),
  control(
    'CAS_EXCLUSIVE_TEMP',
    'packages/db/src/media-store.ts',
    '        constants.O_EXCL |\n',
    '',
    'FS_CAUSAL_CAS_EXCLUSIVE_TEMP',
    floorCases,
  ),
);
const workspaceCases = 'apps/cli/src/commands/fs-workspace-admission.test.ts';
const cooperativeCases = 'packages/db/src/media-store-concurrency.test.ts';
mutations.push(
  control(
    'WORKSPACE_ADMISSION',
    'apps/cli/src/engine/tool-host/fs-admission.ts',
    'if (paths.some(isSensitiveReadPath))',
    'if (false)',
    'FS_CAUSAL_WORKSPACE_ADMISSION',
    [workspaceCases],
    'refuses real argv surface',
  ),
  control(
    'CAS_COOPERATIVE_READ',
    paths,
    '  assertReadableFile(path: string, opened: Stats): void {\n    const current = this.fileSnapshot(path);',
    '  assertReadableFile(path: string, opened: Stats): void {\n    this.assertOwnedFile(path, opened);\n    const current = this.fileSnapshot(path);',
    'FS_CAUSAL_CAS_COOPERATIVE_READ',
    [cooperativeCases],
    'preserves native',
  ),
);
const windowsWinnerCases = 'packages/db/src/media-store-publication-contention.test.ts';
const detachedEntryCases = 'packages/db/src/media-store-entry-snapshots.test.ts';
mutations.push(
  control(
    'CAS_WINDOWS_WINNER',
    'packages/db/src/media-store.ts',
    'if (!isWindowsRenameContention(error))',
    'if (true)',
    'FS_CAUSAL_CAS_WINDOWS_WINNER',
    [windowsWinnerCases],
    'verifies a concurrent winner',
  ),
  control(
    'CAS_DETACHED_ENTRY',
    paths,
    '(info.nlink !== 0 && info.nlink !== 1)',
    'info.nlink !== 1',
    'FS_CAUSAL_CAS_DETACHED_ENTRY',
    [detachedEntryCases],
    'admits a detached final-entry snapshot',
  ),
);
for (const mutation of mutations) {
  const file = mutation.files[0];
  mutation.expectedTests =
    file === floorCases[0]
      ? 9
      : file === workspaceCases
        ? 8
        : file === cooperativeCases
          ? 6
          : file === windowsWinnerCases
            ? 16
            : file === detachedEntryCases
              ? 8
              : 19;
}
