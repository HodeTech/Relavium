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
    "  'KUBECONFIG',\n  'AWS_CONFIG_FILE',\n  'AWS_SHARED_CREDENTIALS_FILE',\n  'AWS_PROFILE',\n  'AWS_DEFAULT_PROFILE',\n  'DOCKER_CONFIG',\n  'GOOGLE_APPLICATION_CREDENTIALS',\n  'AZURE_CONFIG_DIR',\n  'AZURE_AUTH_LOCATION',\n  'CLOUDSDK_CONFIG',\n  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',\n  'TF_CLI_CONFIG_FILE',",
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
    '!info.isDirectory() ||\n        info.isSymbolicLink() ||\n        withOwnedFilesystem(() => realpathSync(dir)) !== dir ||\n        !within(root, dir)',
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
    'fsGrants: runtime.admitFsInvocation(global)',
    'fsGrants: runtime.admitFsInvocation({ ...global, allowFsRoots: [] })',
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
    'GIT_WORKTREE_CONFIG',
    'apps/cli/src/engine/tool-host/fs.ts',
    "(base === 'config' || base === 'config.worktree') &&",
    "base === 'config' &&",
    'FS_CAUSAL_GIT_WORKTREE_CONFIG',
    floorCases,
  ),
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
    "  'application_default_credentials.json',\n  'credentials.tfrc.json',\n  '.terraformrc', // Unix CLI config supports token-bearing credentials blocks.\n  'terraform.rc', // Windows CLI config in APPDATA supports the same credentials blocks.",
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
const nativeRootCases = 'apps/cli/src/engine/tool-host/fs-policy-native-paths.test.ts';
const deleteCases = [
  'packages/db/src/media-store-delete-races.test.ts',
  'apps/cli/src/engine/media-gc-delete-races.test.ts',
];
mutations.push(
  {
    ...control(
      'CAS_DELETE_IDEMPOTENT',
      'packages/db/src/media-store.ts',
      "if (failure.reason === 'missing') {",
      'if (false) {',
      'FS_CAUSAL_CAS_DELETE_IDEMPOTENT',
      deleteCases,
      'keeps two admitted cooperating deletes idempotent',
    ),
    witnesses: [
      {
        target: 'both cooperating grace collectors continue to the orphan phase',
        marker: 'FS_CAUSAL_CAS_DELETE_GC_CONTINUATION',
      },
    ],
  },
  control(
    'NATIVE_CANONICAL_ROOT',
    policy,
    'const canonical = realpathSync.native(lexical);',
    'const canonical = realpathSync(lexical);',
    'FS_CAUSAL_NATIVE_CANONICAL_ROOT',
    [nativeRootCases],
  ),
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
    file === deleteCases[0]
      ? 12
      : file === floorCases[0]
        ? 14
        : file === workspaceCases
          ? 10
          : file === cooperativeCases
            ? 6
            : file === windowsWinnerCases
              ? 16
              : file === detachedEntryCases
                ? 8
                : file === nativeRootCases
                  ? 1
                  : file === cases
                    ? 21
                    : 19;
}

// Both real consumers are mandatory for each shared-ancestor mechanism.
for (const mutation of mutations.filter((entry) => entry.id.startsWith('ancestor-'))) {
  mutation.witnesses = ['tool', 'save_to'].map((port) => ({
    target: `${mutation.target} ${port}`,
    marker: mutation.marker,
  }));
}

// ADR-0106 extends this same physical filesystem family. Counts are complete file
// inventories observed with the source-aliased Step 6 Vitest programme, never -t
// selections. Each replacement removes one production guard without changing the
// test, its setup, its timeout, or the shared evidence authority.
const mediaStore = 'packages/db/src/media-store.ts';
const mediaRead = 'packages/db/src/media-store-read.ts';
const mediaTemp = 'packages/db/src/media-store-temporaries.ts';
const mediaAdmission = 'packages/db/src/media-store-admission.test.ts';
const mediaReadCases = 'packages/db/src/media-store-read-bounds.test.ts';
const mediaTempCases = 'packages/db/src/media-store-temporaries.test.ts';
const mediaEgress = 'packages/db/src/media-egress.ts';
const mediaEgressCases = 'packages/db/src/media-egress-admission.test.ts';
const mediaPublication = 'packages/shared/src/media-publication.test.ts';
const mediaMetadata = 'packages/db/src/media-reference-store.test.ts';
const mediaMetadataProcess = 'packages/db/src/media-reference-store-process.e2e.test.ts';
const mediaEngine = 'apps/cli/src/engine/media-publication.e2e.test.ts';
const mediaSelector = 'packages/llm/src/adapters/media-output-selection.test.ts';
const nativeTemporary = {
  parent: mediaTempCases,
  program: 'packages/db/src/fixtures/media-temporary-worker.ts',
};
const nativeMetadata = {
  parent: mediaMetadataProcess,
  program: 'packages/db/src/fixtures/media-metadata-worker.ts',
};
function mediaControl(id, path, before, after, marker, file, target, expectedTests, nativeChild) {
  return {
    ...control(id, path, before, after, marker, [file], target),
    expectedTests,
    ...(nativeChild === undefined ? {} : { nativeChild }),
  };
}
mutations.push(
  mediaControl(
    'MEDIA_FS_INLINE_BOUND',
    mediaStore,
    'async put(bytes: Uint8Array, mimeType: string): Promise<string> {\n    admitInline(bytes, mimeType);\n    const owned = new Uint8Array(bytes);\n    const verifier = createMediaVerifier(mimeType);\n    verifier.push(owned);\n    verifier.finish();\n    return this.#publish(',
    'async put(bytes: Uint8Array, mimeType: string): Promise<string> {\n    void mimeType;\n    const owned = new Uint8Array(bytes);\n    const verifier = createMediaVerifier(mimeType);\n    verifier.push(owned);\n    verifier.finish();\n    return this.#publish(',
    'MEDIA_STORE_IMAGE_INLINE_BOUND',
    mediaAdmission,
    'admits a structurally complete image',
    21,
  ),
  mediaControl(
    'MEDIA_MEMORY_INLINE_BOUND',
    mediaStore,
    'async put(bytes: Uint8Array, mimeType: string): Promise<string> {\n    admitInline(bytes, mimeType);\n    const owned = new Uint8Array(bytes);\n    const verifier = createMediaVerifier(mimeType);\n    verifier.push(owned);\n    verifier.finish();\n    const handle = handleOf(owned);',
    'async put(bytes: Uint8Array, mimeType: string): Promise<string> {\n    void mimeType;\n    const owned = new Uint8Array(bytes);\n    const verifier = createMediaVerifier(mimeType);\n    verifier.push(owned);\n    verifier.finish();\n    const handle = handleOf(owned);',
    'MEDIA_STORE_IMAGE_INLINE_BOUND',
    mediaAdmission,
    'admits a structurally complete image',
    21,
  ),
  mediaControl(
    'MEDIA_FS_STREAM_BOUND',
    mediaStore,
    "          if (inputByteLength(chunk) > MAX_MEDIA_OBJECT_BYTES - total)\n            throw new MediaAdmissionError('object_limit');\n          const owned = new Uint8Array(chunk);\n          verifier.push(owned);\n          total += owned.length;\n          hash.update(owned);",
    '          void total;\n          const owned = new Uint8Array(chunk);\n          verifier.push(owned);\n          total += owned.length;\n          hash.update(owned);',
    'MEDIA_STORE_STREAM_PRECOPY_BOUND',
    mediaAdmission,
    'refuses an oversized source chunk',
    21,
  ),
  mediaControl(
    'MEDIA_MEMORY_STREAM_BOUND',
    mediaStore,
    "        if (inputByteLength(chunk) > MAX_MEDIA_OBJECT_BYTES - total)\n          throw new MediaAdmissionError('object_limit');\n        const owned = new Uint8Array(chunk);\n        verifier.push(owned);\n        let offset = 0;",
    '        void total;\n        const owned = new Uint8Array(chunk);\n        verifier.push(owned);\n        let offset = 0;',
    'MEDIA_STORE_STREAM_PRECOPY_BOUND',
    mediaAdmission,
    'refuses an oversized source chunk',
    21,
  ),
  mediaControl(
    'MEDIA_FS_FINISH',
    mediaStore,
    "        verifier.finish();\n        return HANDLE_PREFIX + hash.digest('hex');",
    "        void verifier;\n        return HANDLE_PREFIX + hash.digest('hex');",
    'MEDIA_STORE_VERIFIER_FINISH',
    mediaAdmission,
    'requires finish and independent declared format',
    21,
  ),
  mediaControl(
    'MEDIA_MEMORY_FINISH',
    mediaStore,
    '      verifier.finish();\n      const bytes = new Uint8Array(total);',
    '      void verifier;\n      const bytes = new Uint8Array(total);',
    'MEDIA_STORE_VERIFIER_FINISH',
    mediaAdmission,
    'requires finish and independent declared format',
    21,
  ),
  mediaControl(
    'MEDIA_FS_BYTE_VALIDATION',
    mediaRead,
    "if (finished.size !== total || hash.digest('hex') !== digest)",
    'if (finished.size !== total)',
    'FS_CAUSAL_MEDIA_FS_BYTE_VALIDATION',
    mediaAdmission,
    'incremental validation never calls whole-object get',
    21,
  ),
  mediaControl(
    'MEDIA_MEMORY_BYTE_VALIDATION',
    mediaStore,
    'const verifier = createMediaVerifier(snapshot.meta.mimeType);\n    verifier.push(bytes);\n    const evidence = verifier.finish();',
    'const evidence = { ...snapshot.meta, byteLength: bytes.byteLength };',
    'FS_CAUSAL_MEDIA_MEMORY_BYTE_VALIDATION',
    mediaAdmission,
    'requires finish and independent declared format',
    21,
  ),
  mediaControl(
    'MEDIA_FD_PREALLOCATION',
    mediaRead,
    'opened.size > MAX_MEDIA_OBJECT_BYTES',
    'false',
    'MEDIA_STORE_PREALLOCATION_FD_BOUND',
    mediaReadCases,
    'refuses oversized opened fd before any read',
    5,
  ),
  mediaControl(
    'MEDIA_FD_GROWTH',
    mediaRead,
    "if (bytesRead > MAX_MEDIA_OBJECT_BYTES - total)\n          throw new MediaAdmissionError('object_limit');",
    'if (false) void total;',
    'MEDIA_STORE_CUMULATIVE_READ_BOUND',
    mediaReadCases,
    'bounds growth after initial fd stat',
    5,
  ),
  mediaControl(
    'MEDIA_FD_PREDELIVERY_SIGNAL',
    mediaRead,
    '    checkAbort();\n    if (cleanupError !== undefined) throw cleanupError;',
    '    void signal;\n    if (cleanupError !== undefined) throw cleanupError;',
    'FS_CAUSAL_MEDIA_SCANNER_PREDELIVERY_SIGNAL',
    mediaReadCases,
    'scanMediaFile refuses after its own joined native close',
    5,
  ),
  mediaControl(
    'MEDIA_MEMORY_RANGE_SIGNAL',
    mediaStore,
    'const bytes = sliceRange(await this.get(handle), range);\n    assertMediaNotAborted(signal);',
    'const bytes = sliceRange(await this.get(handle), range);\n    void signal;',
    'FS_CAUSAL_MEDIA_MEMORY_RANGE_SIGNAL',
    mediaAdmission,
    'checks pre-abort and abort after awaiting resident delivery',
    21,
  ),
  mediaControl(
    'MEDIA_TEMP_OWNER_ABSENCE',
    mediaTemp,
    'const reason = age(info, now) ?? ownerReason(producer[1]);',
    'const reason = age(info, now);',
    'MEDIA_TEMP_OWNER_ABSENCE',
    mediaTempCases,
    'uses exclusive private owner records',
    23,
    nativeTemporary,
  ),
  mediaControl(
    'MEDIA_TEMP_MINIMUM_AGE',
    mediaTemp,
    'const reason = age(info, now) ?? ownerReason(producer[1]);',
    'const reason = ownerReason(producer[1]);',
    'MEDIA_TEMP_MINIMUM_AGE',
    mediaTempCases,
    'retains young, future, reused PID',
    23,
    nativeTemporary,
  ),
  mediaControl(
    'MEDIA_TEMP_CLAIM_IDENTITY',
    mediaTemp,
    "if (\n        moved === undefined ||\n        !same(moved, info) ||\n        !sameNative(this.nativeFile(join(dir, 'blob'), moved), original)\n      )",
    'if (moved === undefined)',
    'MEDIA_TEMP_INITIAL_CLAIM_IDENTITY',
    mediaTempCases,
    'revalidates the exact original identity',
    23,
    nativeTemporary,
  ),
  mediaControl(
    'MEDIA_TEMP_CLAIM_RECOVERY',
    mediaTemp,
    "const blob = this.child(root, name, identity, 'blob');\n        if (blob !== undefined) {",
    "const blob = this.child(root, name, identity, 'blob');\n        if (false) {",
    'MEDIA_TEMP_DEAD_CLAIM_RECOVERY',
    mediaTempCases,
    'recovers a killed claimant',
    23,
    nativeTemporary,
  ),
  mediaControl(
    'MEDIA_HTTP_HEADER_AGREEMENT',
    mediaEgress,
    '    header !== declared &&\n    !(header ===',
    '    false &&\n    !(header ===',
    'MEDIA_HEADER_PREPULL',
    mediaEgressCases,
    'MEDIA_HEADER_PREPULL: conflicting final type',
    15,
  ),
  mediaControl(
    'MEDIA_HTTP_PCM_HEADER',
    mediaEgress,
    "if (declared === 'audio/L16') throw new MediaAdmissionError('descriptor_conflict');",
    'if (false) return undefined;',
    'MEDIA_PCM_HEADER_REQUIRED',
    mediaEgressCases,
    'MEDIA_PCM_HEADER_REQUIRED: PCM refuses',
    15,
  ),
  mediaControl(
    'MEDIA_HTTP_BODY_FINISH',
    mediaEgress,
    'const actual = verifier.finish();',
    'const actual = { mimeType: declared };',
    'MEDIA_BODY_FINISH',
    mediaEgressCases,
    'MEDIA_BODY_FINISH: complete ADTS framing',
    15,
  ),
  mediaControl(
    'MEDIA_HANDLE_VALIDATION',
    'packages/shared/src/media-deinline.ts',
    'const result = admitMediaDescriptor(await store.validateMedia(handle, descriptor));',
    'const result = admitMediaDescriptor({ ...descriptor, handle, byteLength: actualCount ?? 2 });',
    'media-handle-validation-required',
    mediaPublication,
    'validates handle-only media afresh',
    17,
  ),
  mediaControl(
    'MEDIA_FREE_GRAPH_OWNERSHIP',
    'packages/shared/src/media-deinline.ts',
    'if (items.length === 0) return snapshot.value;',
    'if (items.length === 0) return value;',
    'media-free-owned-before-await',
    mediaPublication,
    'owns media-free containers',
    17,
  ),
  mediaControl(
    'MEDIA_SAME_HASH_PREHOST',
    'packages/shared/src/media-deinline.ts',
    '  compareOriginal(items);',
    '  void items;',
    'FS_CAUSAL_MEDIA_SAME_HASH_BEFORE_READ',
    mediaPublication,
    'rejects all original conflicts',
    17,
  ),
  mediaControl(
    'MEDIA_METADATA_ATOMIC_BATCH',
    'packages/db/src/media-reference-store.ts',
    "db.transaction((tx) => admitBatchTxn(tx, owned, ts), { behavior: 'immediate' }),",
    'admitBatchTxn(db, owned, ts),',
    'FS_CAUSAL_MEDIA_METADATA_ATOMIC_BATCH',
    mediaMetadata,
    'a final tuple conflict rolls back insertion',
    30,
  ),
  mediaControl(
    'MEDIA_METADATA_TUPLE',
    'packages/db/src/media-reference-store.ts',
    'existing.durationMs !== input.durationMs',
    'false',
    'FS_CAUSAL_MEDIA_METADATA_TUPLE',
    mediaMetadata,
    'enriches unknown duration once',
    30,
  ),
  mediaControl(
    'MEDIA_METADATA_NATIVE_TUPLE',
    'packages/db/src/media-reference-store.ts',
    'existing.byteLength !== input.byteLength ||',
    'false ||',
    'FS_CAUSAL_MEDIA_METADATA_NATIVE_SERIALIZATION',
    mediaMetadataProcess,
    'serializes incompatible native writers',
    1,
    nativeMetadata,
  ),
  mediaControl(
    'MEDIA_METADATA_IMMEDIATE',
    'packages/db/src/media-reference-store.ts',
    "db.transaction((tx) => admitBatchTxn(tx, owned, ts), { behavior: 'immediate' }),",
    "db.transaction((tx) => admitBatchTxn(tx, owned, ts), { behavior: 'deferred' }),",
    'FS_CAUSAL_MEDIA_METADATA_IMMEDIATE',
    mediaMetadata,
    'admission and all three GC writers each open an IMMEDIATE transaction',
    30,
  ),
  mediaControl(
    'MEDIA_PRESTATE_ADMISSION',
    'packages/core/src/engine/engine.ts',
    '      await this.#admitMediaValue(pinned);\n      return pinned;',
    '      void pinned;\n      return pinned;',
    'FS_CAUSAL_MEDIA_PRESTATE_ADMISSION',
    mediaEngine,
    'refuses existing SQLite tuple conflict',
    21,
  ),
  mediaControl(
    'MEDIA_PORT_REQUIRED',
    'packages/core/src/engine/engine.ts',
    "if (typeof port.admitProducedMedia !== 'function')\n      throw new MediaAdmissionError('store_contract');",
    "if (typeof port.admitProducedMedia !== 'function') return;",
    'FS_CAUSAL_MEDIA_HANDLE_EVIDENCE',
    mediaEngine,
    'refuses handle-only publication',
    21,
  ),
  mediaControl(
    'MEDIA_TERMINAL_REVALIDATION',
    'packages/core/src/engine/engine.ts',
    'const durable = await deInlineMedia(draft, this.#host.mediaStore, this.#mediaEgress());',
    'const durable = draft;',
    'FS_CAUSAL_MEDIA_TERMINAL_REVALIDATION',
    mediaEngine,
    'fresh terminal validation strips nested media',
    21,
  ),
  mediaControl(
    'MEDIA_PREAPPEND_METADATA',
    'packages/core/src/engine/engine.ts',
    '    await this.#admitMediaValue(durable);\n    return durable as RunEventDraft;',
    '    void durable;\n    return durable as RunEventDraft;',
    'FS_CAUSAL_MEDIA_TERMINAL_METADATA_ADMISSION',
    mediaEngine,
    'fresh terminal metadata admission strips a tuple',
    21,
  ),
  mediaControl(
    'MEDIA_PROVIDER_NATIVE_SELECTOR',
    'packages/llm/src/adapters/openai.ts',
    'if (effective.audio !== undefined) resolveOpenAiAudio({ audio: effective.audio }, provider);',
    'void effective.audio;',
    'MEDIA_SELECTOR_PREENTRY',
    mediaSelector,
    'MEDIA_SELECTOR_PREENTRY: unsupported chat format refuses',
    20,
  ),
);

// Parser authority, borrowed-source ownership and body-lifetime controls use
// existing complete permanent workloads in this same filesystem family.
mutations.push(
  mediaControl(
    'MEDIA_VERIFIER_OBJECT_BOUND',
    'packages/shared/src/media-verifier.ts',
    "if (length > MAX_MEDIA_OBJECT_BYTES - total) throw new MediaAdmissionError('object_limit');",
    "if (false) throw new MediaAdmissionError('object_limit');",
    'media-verifier-object-bound',
    'packages/shared/src/media-verifier.test.ts',
    'counts borrowed bytes without retaining caller mutations',
    34,
  ),
  mediaControl(
    'MEDIA_INSPECTION_SCRATCH_BOUND',
    'packages/shared/src/media-inspection-memory.ts',
    "if (\n      !Number.isSafeInteger(bytes) ||\n      bytes < 0 ||\n      bytes > MAX_MEDIA_INSPECTION_BYTES - this.#allocated\n    )\n      throw new MediaAdmissionError('inspection_limit');",
    "if (false) throw new MediaAdmissionError('inspection_limit');",
    'media-inspection-bound',
    'packages/shared/src/media-verifier.test.ts',
    'streams large comment bodies and late container metadata',
    34,
  ),
  mediaControl(
    'MEDIA_RECOGNIZER_FINISH',
    'packages/shared/src/media-verifier.ts',
    'const mimeType = parser?.finish() ?? declared;',
    'const mimeType = declared;',
    'media-verifier-finish-required',
    'packages/shared/src/media-verifier.test.ts',
    'empty and truncated body refuse at finish',
    34,
  ),
  mediaControl(
    'MEDIA_STRUCTURE_COUNT_BOUND',
    'packages/shared/src/media-verifier-reader.ts',
    "if (value >= maximum) fail('inspection_limit');",
    'void maximum;',
    'media-structure-count-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'PNG skips large ancillary chunks and bounds structure count',
    20,
  ),
  mediaControl(
    'MEDIA_BORROWED_CHUNK_OWNERSHIP',
    'packages/shared/src/media-deinline.ts',
    'return { done: false, value: ownMediaBytes(chunk, length) };',
    'return { done: false, value: chunk };',
    'MEDIA_BORROWED_CHUNK_OWNERSHIP',
    mediaPublication,
    'owns reused borrowed stream chunks',
    17,
  ),
  mediaControl(
    'MEDIA_UPSTREAM_EARLY_CLOSE',
    'packages/shared/src/media-deinline.ts',
    '    if (!drained) {\n      // Success requires EOF above, so an incomplete stream already has a primary refusal.\n      await closeMediaIterator(iterator).catch(() => undefined);\n    }',
    '    if (!drained) {\n      void drained;\n    }',
    'media-stream-early-return-closes-source',
    mediaPublication,
    'closes a single acquired upstream',
    17,
  ),
  mediaControl(
    'MEDIA_HTTP_BODY_ABORT',
    mediaEgress,
    "options.signal?.addEventListener('abort', onAbort);",
    'void onAbort;',
    'MEDIA_HTTP_BODY_ABORT',
    'packages/db/src/media-egress.test.ts',
    'honours the caller AbortSignal mid-body',
    35,
  ),
  mediaControl(
    'MEDIA_NATIVE_HTTP_CLOSE_JOIN',
    mediaEgress,
    'await Promise.allSettled([...nativeClosures]);',
    'void nativeClosures;',
    'MEDIA_NATIVE_CLOSE_JOIN',
    mediaEgressCases,
    'consumer abandonment joins the real owned HTTP response close',
    15,
  ),
);

// These exact/+1 fixtures distinguish the reachable per-format counters from
// defensive parser-step bounds that current grammars cannot request via bytes.
mutations.push(
  mediaControl(
    'MEDIA_READER_REQUEST_BOUND',
    'packages/shared/src/media-verifier-reader.ts',
    "if (!Number.isSafeInteger(size) || size < 0 || size > 4096) fail('inspection_limit');",
    "if (!Number.isSafeInteger(size) || size < 0) fail('inspection_limit');",
    'media-reader-request-bound',
    'packages/shared/src/media-verifier.test.ts',
    'bounds the reader request and skip contracts',
    34,
  ),
  mediaControl(
    'MEDIA_READER_SKIP_BOUND',
    'packages/shared/src/media-verifier-reader.ts',
    'if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024) fail();',
    'if (!Number.isSafeInteger(size) || size < 0) fail();',
    'media-reader-skip-bound',
    'packages/shared/src/media-verifier.test.ts',
    'bounds the reader request and skip contracts',
    34,
  ),
  mediaControl(
    'MEDIA_WEBM_TRACK_COUNT_BOUND',
    'packages/shared/src/media-verifier-webm.ts',
    "if (context !== 'tracks' || allTracks.size >= 32) fail('inspection_limit');",
    "if (context !== 'tracks') fail('inspection_limit');",
    'media-webm-track-count-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'WebM bounds separately identified tracks and blocks',
    20,
  ),
  mediaControl(
    'MEDIA_WEBM_BLOCK_COUNT_BOUND',
    'packages/shared/src/media-verifier-webm.ts',
    "if (blocks.size >= 32 && !blocks.has(number)) fail('inspection_limit');",
    "if (false) fail('inspection_limit');",
    'media-webm-block-count-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'WebM bounds separately identified tracks and blocks',
    20,
  ),
  mediaControl(
    'MEDIA_OGG_COMMENT_COUNT_BOUND',
    'packages/shared/src/media-verifier-ogg.ts',
    "if (n > 65536) fail('inspection_limit');",
    "if (false) fail('inspection_limit');",
    'media-ogg-comment-count-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'Ogg comment count admits exactly 65536',
    20,
  ),
  mediaControl(
    'MEDIA_PDF_ID_HEX_BOUND',
    'packages/shared/src/media-verifier-pdf.ts',
    "if (out.length >= 256) fail('inspection_limit');",
    "if (false) fail('inspection_limit');",
    'media-pdf-id-hex-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'PDF bounds an admitted trailer ID hex token',
    20,
  ),
);

// R1 ordinary regressions remove the exact ownership, format-profile and branch
// publication guards while preserving every established full-file workload above.
mutations.push(
  mediaControl(
    'MEDIA_SOURCE_ALIAS_PREFLIGHT',
    'packages/shared/src/media-publication.ts',
    'if (!countOnly && loose.some((item) => incoming.get(item) !== sourceEdges.get(item)))',
    'if (!countOnly && loose.some((item) => sourceEdges.get(item) === undefined))',
    'MEDIA_SOURCE_ALIAS_PREFLIGHT',
    mediaPublication,
    'refuses a base64 source aliased through record',
    17,
  ),
  mediaControl(
    'MEDIA_WEBM_ENCODING_REFUSAL',
    'packages/shared/src/media-verifier-webm.ts',
    '      } else if (id === 0x6d80) {\n        // ContentEncodings includes encryption and compression. Neither is in the untransformed\n        // WebM profile, so this known element must never fall through to unknown-element skipping.\n        fail();\n      } else if (',
    '      } else if (',
    'MEDIA_WEBM_ENCODING_REFUSAL',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'refuses encrypted V_VP8 tracks',
    20,
  ),
  {
    ...mediaControl(
      'MEDIA_BRANCH_PRESTATE',
      'packages/core/src/engine/engine.ts',
      "if (outcome.kind !== 'completed' && outcome.kind !== 'branch') {",
      "if (outcome.kind !== 'completed') {",
      'FS_CAUSAL_MEDIA_BRANCH_PRESTATE',
      mediaEngine,
      'pins branch media once before state',
      21,
    ),
    witnesses: [
      {
        target: 'refuses 33 branch media parts before any source pull',
        marker: 'FS_CAUSAL_MEDIA_BRANCH_BOUND',
      },
    ],
  },
);

// ADR-0109 keeps the same physical family. These removals distinguish prompt
// foreign observation, exact native ownership, and cleanup-before-native-join.
// The adopted finite EOF row is a trusted-fixture contract, not a shipped guard.
const mediaIterator = 'packages/shared/src/media-iterator.ts';
const mediaIteratorCases = 'packages/shared/src/media-iterator.test.ts';
const mediaDeinline = 'packages/shared/src/media-deinline.ts';
const mediaDeinlineCases = 'packages/shared/src/media-deinline-lifecycle.test.ts';
const mediaIteratorStoreCases = 'packages/db/src/media-iterator-store.test.ts';
const mediaNativeLifecycleCases = 'packages/db/src/media-native-lifecycle.test.ts';
const mediaNativeLifecycleWorker = 'packages/db/src/fixtures/media-native-lifecycle-worker.ts';
const nativeLifecycle = {
  parent: mediaNativeLifecycleCases,
  program: mediaNativeLifecycleWorker,
};
mutations.push(
  {
    ...mediaControl(
      'MEDIA_ITERATOR_FOREIGN_ACK',
      mediaIterator,
      '  if (!state.native) complete();',
      '  if (false) complete();',
      'MEDIA_ITERATOR_FOREIGN_ACK',
      mediaIteratorCases,
      'observes foreign pending return once without joining it',
      14,
    ),
    witnesses: ['throw', 'reject', 'then-getter'].map((kind) => ({
      target: `discards foreign ${kind} diagnostics`,
      marker: 'MEDIA_ITERATOR_FOREIGN_DIAGNOSTIC_FINITE',
    })),
  },
  mediaControl(
    'MEDIA_ITERATOR_REENTRY_CACHE',
    mediaIterator,
    '  state.acknowledgement = acknowledgement;',
    '  state.acknowledgement = Promise.resolve();',
    'MEDIA_ITERATOR_REENTRY_CACHE',
    mediaIteratorCases,
    'caches native acknowledgement before re-entrant return',
    14,
  ),
  mediaControl(
    'MEDIA_ITERATOR_CAPTURED_RETURN',
    mediaIterator,
    'invoke: (): unknown => Reflect.apply(operation, iterator, []),',
    'invoke: (): unknown => iterator.return?.(),',
    'MEDIA_ITERATOR_CAPTURED_RETURN',
    mediaIteratorCases,
    'captures the original native return and receiver',
    14,
  ),
  mediaControl(
    'MEDIA_ITERATOR_DUPLICATE_PREFLIGHT',
    mediaIterator,
    "    if (closes.has(iterator)) throw new MediaAdmissionError('source_failed');\n    const operation: unknown = Reflect.get(iterator, 'return');",
    "    if (false) throw new MediaAdmissionError('source_failed');\n    const operation: unknown = Reflect.get(iterator, 'return');",
    'MEDIA_ITERATOR_DUPLICATE_PREFLIGHT',
    mediaIteratorCases,
    'refuses duplicate registration before reading a replaced return getter',
    14,
  ),
  mediaControl(
    'MEDIA_ITERATOR_LATE_PROMOTION',
    mediaIterator,
    "    if (closes.has(iterator)) throw new MediaAdmissionError('source_failed');\n    closes.set(iterator, {",
    "    if (false) throw new MediaAdmissionError('source_failed');\n    closes.set(iterator, {",
    'MEDIA_ITERATOR_LATE_PROMOTION',
    mediaIteratorCases,
    'refuses late promotion when return capture re-enters a foreign close',
    14,
  ),
  mediaControl(
    'MEDIA_COUNTED_RETURN_PROMPT',
    mediaDeinline,
    '          void closeMediaIterator(iterator).catch(() => undefined);\n          return Promise.resolve({ done: true, value: undefined });',
    '          void closeMediaIterator(iterator).catch(() => undefined);\n          return closeMediaIterator(iterator).then((): IteratorResult<Uint8Array> => ({ done: true, value: undefined }));',
    'MEDIA_COUNTED_RETURN_PROMPT',
    mediaDeinlineCases,
    'lets the counted consumer clean before joining native resolve',
    4,
  ),
  mediaControl(
    'MEDIA_DEINLINE_NATIVE_JOIN',
    mediaDeinline,
    '      await closeMediaIterator(iterator).catch(() => undefined);',
    '      void closeMediaIterator(iterator).catch(() => undefined);',
    'MEDIA_DEINLINE_NATIVE_JOIN',
    mediaDeinlineCases,
    'lets the counted consumer clean before joining native resolve',
    4,
  ),
);

// Both stores have independently meaningful foreign-finishing and native-join
// sites; the filesystem return-await additionally enforces local temp/fd order.
const fsStoreClose =
  '    } finally {\n      if (!ended) await closeMediaIteratorPreservingFailure(iterator);\n    }\n  }\n\n  async #publish';
const memoryStoreClose =
  '      block = undefined;\n      if (!ended) await closeMediaIteratorPreservingFailure(iterator);';
mutations.push(
  mediaControl(
    'MEDIA_FS_STORE_FOREIGN_FINITE',
    mediaStore,
    fsStoreClose,
    '    } finally {\n      if (!ended) await iterator.return?.();\n    }\n  }\n\n  async #publish',
    'MEDIA_STORE_FOREIGN_CLOSE_FINITE',
    mediaIteratorStoreCases,
    'filesystem iterator retirement retires owned storage despite a foreign pending return',
    6,
  ),
  mediaControl(
    'MEDIA_FS_STORE_NATIVE_JOIN',
    mediaStore,
    fsStoreClose,
    '    } finally {\n      if (!ended) void closeMediaIterator(iterator).catch(() => undefined);\n    }\n  }\n\n  async #publish',
    'MEDIA_STORE_NATIVE_CLOSE_JOIN',
    mediaIteratorStoreCases,
    'filesystem iterator retirement cleans owned storage before joining registered return',
    6,
  ),
  mediaControl(
    'MEDIA_MEMORY_STORE_FOREIGN_FINITE',
    mediaStore,
    memoryStoreClose,
    '      block = undefined;\n      if (!ended) await iterator.return?.();',
    'MEDIA_STORE_FOREIGN_CLOSE_FINITE',
    mediaIteratorStoreCases,
    'memory iterator retirement retires owned storage despite a foreign pending return',
    6,
  ),
  mediaControl(
    'MEDIA_MEMORY_STORE_NATIVE_JOIN',
    mediaStore,
    memoryStoreClose,
    '      block = undefined;\n      if (!ended) void closeMediaIterator(iterator).catch(() => undefined);',
    'MEDIA_STORE_NATIVE_CLOSE_JOIN',
    mediaIteratorStoreCases,
    'memory iterator retirement cleans owned storage before joining registered return',
    6,
  ),
  mediaControl(
    'MEDIA_FS_STORE_LOCAL_FIRST',
    mediaStore,
    '          const owned = new Uint8Array(chunk);\n          verifier.push(owned);\n          total += owned.length;\n          hash.update(owned);',
    '          const owned = new Uint8Array(chunk);\n          try {\n            verifier.push(owned);\n          } catch (error) {\n            await closeMediaIteratorPreservingFailure(iterator);\n            throw error;\n          }\n          total += owned.length;\n          hash.update(owned);',
    'MEDIA_STORE_LOCAL_CLEANUP_BEFORE_CLOSE',
    mediaIteratorStoreCases,
    'filesystem iterator retirement cleans owned storage before joining registered return',
    6,
  ),
  {
    ...mediaControl(
      'MEDIA_NATIVE_PUBLIC_ADOPTION',
      mediaEgress,
      'return deps === nodeEgressDeps ? registerNativeMediaIterator(iterator) : iterator;',
      'return iterator;',
      'MEDIA_NATIVE_CONSTRUCTOR_REGISTERED',
      mediaNativeLifecycleCases,
      'lazy: exact public native registration precedes the lazy first pull',
      8,
      nativeLifecycle,
    ),
    witnesses: [
      {
        target:
          'deinline-eio: de-inline EIO cleans the real temporary before joining actual native close',
        marker: 'FS_CAUSAL_MEDIA_NATIVE_CLOSE_JOIN',
      },
    ],
  },
  mediaControl(
    'MEDIA_NATIVE_DEPS_EXACT',
    mediaEgress,
    'return deps === nodeEgressDeps ? registerNativeMediaIterator(iterator) : iterator;',
    'return registerNativeMediaIterator(iterator);',
    'MEDIA_NATIVE_INJECTED_FOREIGN',
    mediaNativeLifecycleCases,
    'injected-foreign: injected dependencies remain foreign until explicit trusted adoption',
    8,
    nativeLifecycle,
  ),
  mediaControl(
    'MEDIA_ADOPTED_FINITE_EOF_FIXTURE_CONTRACT',
    mediaNativeLifecycleWorker,
    '        // A finite view must join upstream before *natural* EOF, as well as return.\n        await closeMediaIterator(upstream);\n        eofReported = true;',
    '        // A finite view must join upstream before *natural* EOF, as well as return.\n        void closeMediaIterator(upstream).catch(() => undefined);\n        eofReported = true;',
    'FS_CAUSAL_MEDIA_ADOPTED_EOF_JOIN',
    mediaNativeLifecycleCases,
    'adopted-eof: an adopted finite view joins real native close before EOF and publication',
    8,
    nativeLifecycle,
  ),
);

// R2 closes ambiguous video singleton identities and preserves raw native response
// header multiplicity. These four rows retain the original 89 IDs and workloads.
const mediaIdentityCases = 'packages/shared/src/media-verifier-identity.test.ts';
const mediaNativeHeadersCases = 'packages/db/src/media-native-headers.test.ts';
const nativeHeaders = {
  parent: mediaNativeHeadersCases,
  program: 'packages/db/src/fixtures/media-native-headers-worker.ts',
};
const nativeHeaderTarget =
  'whole-buffer native Content-Type admission identical retains original field multiplicity before body consumption';
const nativeHeaderStoreTarget =
  'filesystem-store native Content-Type admission identical retains original field multiplicity before body consumption';
mutations.push(
  {
    ...mediaControl(
      'MEDIA_WEBM_SINGULAR_IDENTITY',
      'packages/shared/src/media-verifier-webm.ts',
      '        if (seen.has(id)) fail();',
      '        if (false) fail();',
      'MEDIA_WEBM_SINGULAR_IDENTITY',
      mediaIdentityCases,
      'WebM unknown then supported codec',
      30,
    ),
    witnesses: [
      {
        target: 'WebM two supported codecs reversed',
        marker: 'MEDIA_WEBM_SINGULAR_IDENTITY',
      },
    ],
  },
  {
    ...mediaControl(
      'MEDIA_MP4_SINGULAR_IDENTITY',
      'packages/shared/src/media-verifier-mp4.ts',
      '        if (track.seen.has(identity)) fail();',
      '        if (false) fail();',
      'MEDIA_MP4_SINGULAR_IDENTITY',
      mediaIdentityCases,
      'MP4 repeated handler soun-vide',
      30,
    ),
    witnesses: [
      {
        target: 'MP4 repeated handler vide-vide',
        marker: 'MEDIA_MP4_SINGULAR_IDENTITY',
      },
      {
        target: 'MP4 undeclared extra sample entry bef',
        marker: 'MEDIA_MP4_SINGULAR_IDENTITY',
      },
    ],
  },
  {
    ...mediaControl(
      'MEDIA_NATIVE_HEADER_PRESERVATION',
      'packages/db/src/safe-egress.ts',
      '              contentTypeValues: originalContentTypeValues(incoming.rawHeaders),',
      '',
      'MEDIA_NATIVE_HEADER_MULTIPLICITY',
      mediaNativeHeadersCases,
      nativeHeaderTarget,
      18,
      nativeHeaders,
    ),
    witnesses: [{ target: nativeHeaderStoreTarget, marker: 'MEDIA_NATIVE_HEADER_MULTIPLICITY' }],
  },
  {
    ...mediaControl(
      'MEDIA_NATIVE_HEADER_ADMISSION',
      mediaEgress,
      "  if (entries.length > 1 || values.length > 1) throw new MediaAdmissionError('descriptor_conflict');",
      "  if (entries.length > 1) throw new MediaAdmissionError('descriptor_conflict');",
      'MEDIA_NATIVE_HEADER_MULTIPLICITY',
      mediaNativeHeadersCases,
      nativeHeaderTarget,
      18,
      nativeHeaders,
    ),
    witnesses: [{ target: nativeHeaderStoreTarget, marker: 'MEDIA_NATIVE_HEADER_MULTIPLICITY' }],
  },
);

// R3: a rejected genuine Promise returned by an iterator may poison its own
// `then`; the observer must use the captured intrinsic in both dispatch paths.
const mediaReturnDiagnosticsCases = 'packages/db/src/media-return-diagnostics.test.ts';
mutations.push({
  ...mediaControl(
    'MEDIA_RETURN_ORIGINAL_REJECTION_OBSERVED',
    mediaIterator,
    '    try {\n      // Native Promise branding crosses realms. Its own replaceable `then` cannot hide a\n      // rejection; normal constructor/species behaviour remains a trusted JS precondition.\n      void Reflect.apply(promiseThen, returned, [complete, failed]);\n    } catch {\n      // Non-Promise thenables still use normal assimilation, including fixed getter failures.\n      void Reflect.apply(promiseThen, resolvePromise(returned), [complete, failed]);\n    }',
    '    void Promise.resolve(returned).then(complete, failed);',
    'MEDIA_RETURN_DIAGNOSTICS_OBSERVED',
    mediaReturnDiagnosticsCases,
    'foreign iterator return observes the original rejection without leaking host diagnostics',
    2,
    {
      parent: mediaReturnDiagnosticsCases,
      program: 'packages/db/src/fixtures/media-return-diagnostics-worker.ts',
    },
  ),
  witnesses: [
    {
      target:
        'registered iterator return observes the original rejection without leaking host diagnostics',
      marker: 'MEDIA_RETURN_DIAGNOSTICS_OBSERVED',
    },
  ],
});

// R3: v2 recovery must compare native claim identities without passing through
// Number's precision ceiling. The collision case keeps both exact values distinct.
mutations.push(
  mediaControl(
    'MEDIA_TEMP_NATIVE_IDENTITY_PRECISION',
    mediaTemp,
    "if (original.dev !== device || original.ino !== inode) return 'identity_changed';",
    "if (Number.parseInt(original.dev, 36) !== Number.parseInt(device, 36) || Number.parseInt(original.ino, 36) !== Number.parseInt(inode, 36)) return 'identity_changed';",
    'MEDIA_TEMP_NATIVE_IDENTITY_PRECISION',
    mediaTempCases,
    'retains a mismatched claimed file identity and corrupt claim children',
    23,
    nativeTemporary,
  ),
);

// R4: every nested video selector spelling must refuse before the installed SDK entry.
mutations.push({
  ...mediaControl(
    'MEDIA_VIDEO_SELECTOR_PREENTRY',
    'packages/llm/src/adapters/openai.ts',
    'native[req.modality]',
    "native[req.modality === 'image' ? 'image' : 'audio']",
    'MEDIA_VIDEO_SELECTOR_PREENTRY',
    mediaSelector,
    'MEDIA_VIDEO_SELECTOR_PREENTRY: unsupported native format refuses before SDK entry',
    20,
  ),
  witnesses: [
    {
      target:
        'MEDIA_VIDEO_SELECTOR_PREENTRY: unsupported native output_format refuses before SDK entry',
      marker: 'MEDIA_VIDEO_SELECTOR_PREENTRY',
    },
    {
      target:
        'MEDIA_VIDEO_SELECTOR_PREENTRY: unsupported native response_format refuses before SDK entry',
      marker: 'MEDIA_VIDEO_SELECTOR_PREENTRY',
    },
  ],
});

// R5: whole-buffer collection must own borrowed Buffer/subclass bytes before another pull.
mutations.push({
  ...mediaControl(
    'MEDIA_WHOLE_BUFFER_OWNERSHIP',
    mediaEgress,
    'const owned = new Uint8Array(chunk);',
    'const owned = chunk.slice();',
    'MEDIA_WHOLE_BUFFER_OWNERSHIP',
    'packages/db/src/media-egress-ownership.test.ts',
    'MEDIA_WHOLE_BUFFER_OWNERSHIP: owns reused Buffer before the next pull',
    3,
  ),
  witnesses: [
    {
      target: 'MEDIA_WHOLE_BUFFER_OWNERSHIP: owns reused subclass before the next pull',
      marker: 'MEDIA_WHOLE_BUFFER_OWNERSHIP',
    },
  ],
});

// R6: configured response limits count intrinsic bytes in both buffering and streaming paths.
const egressByteCases = 'packages/db/src/safe-egress-bytes.test.ts';
mutations.push({
  ...mediaControl(
    'EGRESS_INTRINSIC_BOUND',
    'packages/db/src/safe-egress.ts',
    'const length: unknown = byteLengthDescriptor.get.call(chunk);',
    'const length: unknown = chunk.length;',
    'EGRESS_INTRINSIC_BOUND',
    egressByteCases,
    "EGRESS_INTRINSIC_BOUND: 'stream' 'shadowed' at limit 3",
    28,
  ),
  witnesses: [
    {
      target: "EGRESS_INTRINSIC_BOUND: 'read' 'shadowed' at limit 3",
      marker: 'EGRESS_INTRINSIC_BOUND',
    },
    {
      target: "EGRESS_INTRINSIC_BOUND: media 'read' refuses oversized 'Buffer' before delivery",
      marker: 'EGRESS_INTRINSIC_BOUND',
    },
    {
      target: "EGRESS_INTRINSIC_BOUND: media 'stream' refuses oversized 'Buffer' before delivery",
      marker: 'EGRESS_INTRINSIC_BOUND',
    },
  ],
});
mutations.push({
  ...mediaControl(
    'EGRESS_BUFFER_OWNERSHIP',
    'packages/db/src/safe-egress.ts',
    'chunks.push(new Uint8Array(chunk));',
    'chunks.push(chunk);',
    'EGRESS_BUFFER_OWNERSHIP',
    egressByteCases,
    'EGRESS_BUFFER_OWNERSHIP: owns reused ordinary before another pull',
    28,
  ),
  witnesses: [
    {
      target: 'EGRESS_BUFFER_OWNERSHIP: owns reused Buffer before another pull',
      marker: 'EGRESS_BUFFER_OWNERSHIP',
    },
  ],
});

mutations.push(
  {
    ...mediaControl(
      'MEDIA_TEMP_CLEANUP_WINNER',
      mediaTemp,
      'if (completed && removed) outcome = undefined;',
      'if (false) outcome = undefined;',
      'MEDIA_TEMP_RECOVERY_CLEANUP_WINNER',
      mediaTempCases,
      'counts the final recovery cleanup winner when its peer loses at directory',
      23,
      nativeTemporary,
    ),
    witnesses: [
      {
        marker: 'MEDIA_TEMP_RECOVERY_CLEANUP_WINNER',
        target: 'counts the final recovery cleanup winner when its peer loses at rmdir',
      },
    ],
  },
  {
    ...mediaControl(
      'MEDIA_TEMP_CLEANUP_ABSENCE',
      mediaTemp,
      "if (missing || code(error) === 'ENOTEMPTY' || code(error) === 'EEXIST')",
      "if (code(error) === 'ENOTEMPTY' || code(error) === 'EEXIST')",
      'MEDIA_TEMP_RECOVERY_CLEANUP_WINNER',
      mediaTempCases,
      'counts the final recovery cleanup winner when its peer loses at directory',
      23,
      nativeTemporary,
    ),
    witnesses: [
      {
        marker: 'MEDIA_TEMP_RECOVERY_CLEANUP_WINNER',
        target: 'counts the final recovery cleanup winner when its peer loses at rmdir',
      },
    ],
  },
);

// PR #94 R94-2: restore only the obsolete OpusTags-tail refusal. Every file runs
// completely; the independent verifier, both real stores and installed SDK publication
// must each produce their own named AssertionError rather than an uncaught format error.
mutations.push({
  ...control(
    'MEDIA_OPUS_TAGS_TAIL',
    'packages/shared/src/media-verifier-ogg.ts',
    "              if (codec === 'audio/ogg') {\n                if (commentFrame || b !== 1) fail();\n                commentFrame = true;\n              }",
    "              if (codec !== 'audio/ogg' || commentFrame || b !== 1) fail();\n              commentFrame = true;",
    'MEDIA_OPUS_TAGS_TAIL',
    [
      'packages/shared/src/media-verifier-opus.test.ts',
      'packages/db/src/media-opus-admission.test.ts',
      'apps/cli/src/engine/media-provider-admission.test.ts',
    ],
    'MEDIA_OPUS_TAGS_TAIL: binary first 1 survives',
  ),
  expectedTests: 42,
  witnesses: [
    { target: 'MEDIA_OPUS_TAGS_TAIL: one zero survives', marker: 'MEDIA_OPUS_TAGS_TAIL' },
    {
      target: 'MEDIA_OPUS_TAGS_CONTINUATION: 70000-byte packet',
      marker: 'MEDIA_OPUS_TAGS_CONTINUATION',
    },
    ...['memory', 'filesystem'].flatMap((store) =>
      ['put', 'putStream'].map((method) => ({
        target: `${store} Opus byte admission MEDIA_OPUS_STORE_TAIL: ${method} preserves`,
        marker: 'MEDIA_OPUS_STORE_TAIL',
      })),
    ),
    ...[true, false].map((canonical) => ({
      target: `OpenAI opus padded canonical=${canonical} SDK HTTP`,
      marker: 'MEDIA_PROVIDER_ADMISSION_BEFORE_APPEND',
    })),
    {
      target: 'OpenAI opus padded SDK binary HTTP',
      marker: 'MEDIA_PROVIDER_ADMISSION_BEFORE_APPEND',
    },
  ],
});

// PR #94 R94-3: remove one scalar block rule at a time. Each CRC-valid fixture
// isolates that rule: [1,1] fixed/[1,16] variable minimum, [32,16,32] equality,
// and [16,32] at EOF for final growth. Complete files keep their valid pairs.
const flacBlockFiles = [
  'packages/shared/src/media-verifier-flac.test.ts',
  'packages/db/src/media-flac-admission.test.ts',
  'apps/cli/src/engine/media-flac-publication.test.ts',
];
function flacBlockWitnesses(rule) {
  return [
    ...['memory', 'filesystem'].flatMap((store) =>
      ['put', 'putStream'].map((method) => ({
        target: `${store} FLAC byte admission MEDIA_FLAC_STORE_${rule}: ${method} refuses`,
        marker: `MEDIA_FLAC_STORE_${rule}`,
      })),
    ),
    { target: `MEDIA_FLAC_LEGACY_${rule}: revalidation`, marker: `MEDIA_FLAC_LEGACY_${rule}` },
    {
      target: `MEDIA_FLAC_PUBLICATION_${rule}: refuses`,
      marker: `MEDIA_FLAC_PUBLICATION_${rule}`,
    },
  ];
}
mutations.push(
  {
    ...control(
      'MEDIA_FLAC_NONFINAL_MINIMUM',
      'packages/shared/src/media-verifier-flac.ts',
      'if (previousBlock < minBlock) fail();',
      'void minBlock;',
      'MEDIA_FLAC_MINIMUM_FIXED',
      flacBlockFiles,
      'MEDIA_FLAC_MINIMUM_FIXED: refuses independently',
    ),
    expectedTests: 138,
    witnesses: [
      {
        target: 'MEDIA_FLAC_MINIMUM_VARIABLE: refuses independently',
        marker: 'MEDIA_FLAC_MINIMUM_VARIABLE',
      },
      ...flacBlockWitnesses('MINIMUM_FIXED'),
      ...flacBlockWitnesses('MINIMUM_VARIABLE'),
    ],
  },
  {
    ...control(
      'MEDIA_FLAC_FIXED_NONFINAL',
      'packages/shared/src/media-verifier-flac.ts',
      'else if (previousBlock !== fixedBlock) fail();',
      'else void previousBlock;',
      'MEDIA_FLAC_FIXED_NONFINAL',
      flacBlockFiles,
      'MEDIA_FLAC_FIXED_NONFINAL: refuses independently',
    ),
    expectedTests: 138,
    witnesses: flacBlockWitnesses('FIXED_NONFINAL'),
  },
  {
    ...control(
      'MEDIA_FLAC_FIXED_FINAL_GROWTH',
      'packages/shared/src/media-verifier-flac.ts',
      'if (strategy === 0 && fixedBlock !== 0 && block > fixedBlock) fail();',
      'void fixedBlock;',
      'MEDIA_FLAC_FIXED_FINAL_GROWTH',
      flacBlockFiles,
      'MEDIA_FLAC_FIXED_FINAL_GROWTH: refuses independently',
    ),
    expectedTests: 138,
    witnesses: flacBlockWitnesses('FIXED_FINAL_GROWTH'),
  },
);

// Subsequent PR #94 review: independently CRC-valid predictor/metadata fixtures
// pin each mandatory field without conflating it with the older block rules.
for (const [rule, before, after] of [
  [
    'PARTITION_EQUALITY',
    'if (block % partitions !== 0 || block / partitions <= order) fail();',
    'if (block % partitions !== 0 || block / partitions < order) fail();',
  ],
  [
    'PADDING_ZERO',
    'for (const value of bytes) if (value !== 0) fail();',
    'for (const value of bytes) void value;',
  ],
  ['APPLICATION_MINIMUM', 'if (type === 2 && length < 4) fail();', 'void type;'],
]) {
  mutations.push({
    ...control(
      `MEDIA_FLAC_${rule}`,
      'packages/shared/src/media-verifier-flac.ts',
      before,
      after,
      `MEDIA_FLAC_${rule}`,
      flacBlockFiles,
      `MEDIA_FLAC_${rule}: refuses an independently checksummed structural violation`,
    ),
    expectedTests: 138,
    witnesses: flacBlockWitnesses(rule),
  });
}

// Generated-result publication keeps the object bound before decoding and reservation.
mutations.push({
  ...mediaControl(
    'MEDIA_GENERATED_OBJECT_PREFLIGHT',
    'packages/shared/src/media-deinline.ts',
    "    if (source['data'].length > 4 * Math.ceil(MAX_MEDIA_OBJECT_BYTES / 3))\n      throw new MediaAdmissionError('object_limit');\n    const n = decodedBase64ByteLength(source['data']);\n    if (n === undefined) throw new MediaAdmissionError('invalid_descriptor');\n    if (n > MAX_MEDIA_OBJECT_BYTES) throw new MediaAdmissionError('object_limit');",
    "    const n = decodedBase64ByteLength(source['data']);\n    if (n === undefined) throw new MediaAdmissionError('invalid_descriptor');",
    'MEDIA_GENERATED_OBJECT_PREFLIGHT',
    'packages/shared/src/media-generated-result.test.ts',
    'MEDIA_GENERATED_OBJECT_PREFLIGHT: rejects object capacity +1',
    18,
  ),
  witnesses: [
    {
      target: 'MEDIA_GENERATED_OBJECT_PREFLIGHT: rejects object capacity +3',
      marker: 'MEDIA_GENERATED_OBJECT_PREFLIGHT',
    },
  ],
});
