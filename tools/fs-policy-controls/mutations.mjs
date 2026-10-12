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
        ? 11
        : file === workspaceCases
          ? 8
          : file === cooperativeCases
            ? 6
            : file === windowsWinnerCases
              ? 16
              : file === detachedEntryCases
                ? 8
                : file === nativeRootCases
                  ? 1
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
function mediaControl(id, path, before, after, marker, file, target, expectedTests) {
  return {
    ...control(id, path, before, after, marker, [file], target),
    expectedTests,
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
    19,
  ),
  mediaControl(
    'MEDIA_MEMORY_INLINE_BOUND',
    mediaStore,
    'async put(bytes: Uint8Array, mimeType: string): Promise<string> {\n    admitInline(bytes, mimeType);\n    const owned = new Uint8Array(bytes);\n    const verifier = createMediaVerifier(mimeType);\n    verifier.push(owned);\n    verifier.finish();\n    const handle = handleOf(owned);',
    'async put(bytes: Uint8Array, mimeType: string): Promise<string> {\n    void mimeType;\n    const owned = new Uint8Array(bytes);\n    const verifier = createMediaVerifier(mimeType);\n    verifier.push(owned);\n    verifier.finish();\n    const handle = handleOf(owned);',
    'MEDIA_STORE_IMAGE_INLINE_BOUND',
    mediaAdmission,
    'admits a structurally complete image',
    19,
  ),
  mediaControl(
    'MEDIA_FS_STREAM_BOUND',
    mediaStore,
    "const hash = createHash('sha256');\n      let total = 0;\n      for await (const chunk of chunks) {\n        if (inputByteLength(chunk) > MAX_MEDIA_OBJECT_BYTES - total)\n          throw new MediaAdmissionError('object_limit');",
    "const hash = createHash('sha256');\n      let total = 0;\n      for await (const chunk of chunks) {\n        void total;",
    'MEDIA_STORE_STREAM_PRECOPY_BOUND',
    mediaAdmission,
    'refuses an oversized source chunk',
    19,
  ),
  mediaControl(
    'MEDIA_MEMORY_STREAM_BOUND',
    mediaStore,
    "let used = 0;\n    let total = 0;\n    for await (const chunk of chunks) {\n      if (inputByteLength(chunk) > MAX_MEDIA_OBJECT_BYTES - total)\n        throw new MediaAdmissionError('object_limit');",
    'let used = 0;\n    let total = 0;\n    for await (const chunk of chunks) {\n      void total;',
    'MEDIA_STORE_STREAM_PRECOPY_BOUND',
    mediaAdmission,
    'refuses an oversized source chunk',
    19,
  ),
  mediaControl(
    'MEDIA_FS_FINISH',
    mediaStore,
    "      verifier.finish();\n      return HANDLE_PREFIX + hash.digest('hex');",
    "      void verifier;\n      return HANDLE_PREFIX + hash.digest('hex');",
    'MEDIA_STORE_VERIFIER_FINISH',
    mediaAdmission,
    'requires finish and independent declared format',
    19,
  ),
  mediaControl(
    'MEDIA_MEMORY_FINISH',
    mediaStore,
    '    verifier.finish();\n    const bytes = new Uint8Array(total);',
    '    void verifier;\n    const bytes = new Uint8Array(total);',
    'MEDIA_STORE_VERIFIER_FINISH',
    mediaAdmission,
    'requires finish and independent declared format',
    19,
  ),
  mediaControl(
    'MEDIA_FS_BYTE_VALIDATION',
    mediaRead,
    "if (finished.size !== total || hash.digest('hex') !== digest)",
    'if (finished.size !== total)',
    'FS_CAUSAL_MEDIA_FS_BYTE_VALIDATION',
    mediaAdmission,
    'incremental validation never calls whole-object get',
    19,
  ),
  mediaControl(
    'MEDIA_MEMORY_BYTE_VALIDATION',
    mediaStore,
    'const verifier = createMediaVerifier(snapshot.meta.mimeType);\n    verifier.push(bytes);\n    const evidence = verifier.finish();',
    'const evidence = { ...snapshot.meta, byteLength: bytes.byteLength };',
    'FS_CAUSAL_MEDIA_MEMORY_BYTE_VALIDATION',
    mediaAdmission,
    'requires finish and independent declared format',
    19,
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
    19,
  ),
  mediaControl(
    'MEDIA_TEMP_OWNER_ABSENCE',
    mediaTemp,
    'const reason = age(info, now) ?? ownerReason(producer[1]);',
    'const reason = age(info, now);',
    'MEDIA_TEMP_OWNER_ABSENCE',
    mediaTempCases,
    'uses exclusive private owner records',
    19,
  ),
  mediaControl(
    'MEDIA_TEMP_MINIMUM_AGE',
    mediaTemp,
    'const reason = age(info, now) ?? ownerReason(producer[1]);',
    'const reason = ownerReason(producer[1]);',
    'MEDIA_TEMP_MINIMUM_AGE',
    mediaTempCases,
    'retains young, future, reused PID',
    19,
  ),
  mediaControl(
    'MEDIA_TEMP_CLAIM_IDENTITY',
    mediaTemp,
    'if (moved === undefined || !same(moved, info))',
    'if (moved === undefined)',
    'MEDIA_TEMP_INITIAL_CLAIM_IDENTITY',
    mediaTempCases,
    'revalidates the exact original identity',
    19,
  ),
  mediaControl(
    'MEDIA_TEMP_CLAIM_RECOVERY',
    mediaTemp,
    "const blob = this.child(root, name, identity, 'blob');\n        if (blob !== undefined) {",
    "const blob = this.child(root, name, identity, 'blob');\n        if (false) {",
    'MEDIA_TEMP_DEAD_CLAIM_RECOVERY',
    mediaTempCases,
    'recovers a killed claimant',
    19,
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
    12,
  ),
  mediaControl(
    'MEDIA_FREE_GRAPH_OWNERSHIP',
    'packages/shared/src/media-deinline.ts',
    'if (items.length === 0) return snapshot.value;',
    'if (items.length === 0) return value;',
    'media-free-owned-before-await',
    mediaPublication,
    'owns media-free containers',
    12,
  ),
  mediaControl(
    'MEDIA_SAME_HASH_PREHOST',
    'packages/shared/src/media-deinline.ts',
    '  compareOriginal(items);',
    '  void items;',
    'FS_CAUSAL_MEDIA_SAME_HASH_BEFORE_READ',
    mediaPublication,
    'rejects all original conflicts',
    12,
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
    18,
  ),
  mediaControl(
    'MEDIA_PORT_REQUIRED',
    'packages/core/src/engine/engine.ts',
    "if (typeof port.admitProducedMedia !== 'function')\n      throw new MediaAdmissionError('store_contract');",
    "if (typeof port.admitProducedMedia !== 'function') return;",
    'FS_CAUSAL_MEDIA_HANDLE_EVIDENCE',
    mediaEngine,
    'refuses handle-only publication',
    18,
  ),
  mediaControl(
    'MEDIA_TERMINAL_REVALIDATION',
    'packages/core/src/engine/engine.ts',
    'const durable = await deInlineMedia(draft, this.#host.mediaStore, this.#mediaEgress());',
    'const durable = draft;',
    'FS_CAUSAL_MEDIA_TERMINAL_REVALIDATION',
    mediaEngine,
    'fresh terminal validation strips nested media',
    18,
  ),
  mediaControl(
    'MEDIA_PREAPPEND_METADATA',
    'packages/core/src/engine/engine.ts',
    '    await this.#admitMediaValue(durable);\n    return durable as RunEventDraft;',
    '    void durable;\n    return durable as RunEventDraft;',
    'FS_CAUSAL_MEDIA_TERMINAL_METADATA_ADMISSION',
    mediaEngine,
    'fresh terminal metadata admission strips a tuple',
    18,
  ),
  mediaControl(
    'MEDIA_PROVIDER_NATIVE_SELECTOR',
    'packages/llm/src/adapters/openai.ts',
    'if (effective.audio !== undefined) resolveOpenAiAudio({ audio: effective.audio }, provider);',
    'void effective.audio;',
    'MEDIA_SELECTOR_PREENTRY',
    mediaSelector,
    'MEDIA_SELECTOR_PREENTRY: unsupported chat format refuses',
    15,
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
    17,
  ),
  mediaControl(
    'MEDIA_BORROWED_CHUNK_OWNERSHIP',
    'packages/shared/src/media-deinline.ts',
    'return { done: false, value: ownMediaBytes(chunk, length) };',
    'return { done: false, value: chunk };',
    'MEDIA_BORROWED_CHUNK_OWNERSHIP',
    mediaPublication,
    'owns reused borrowed stream chunks',
    12,
  ),
  mediaControl(
    'MEDIA_UPSTREAM_EARLY_CLOSE',
    'packages/shared/src/media-deinline.ts',
    'const cleanup = close();',
    'const cleanup = Promise.resolve();',
    'media-stream-early-return-closes-source',
    mediaPublication,
    'closes a single acquired upstream',
    12,
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
    17,
  ),
  mediaControl(
    'MEDIA_WEBM_BLOCK_COUNT_BOUND',
    'packages/shared/src/media-verifier-webm.ts',
    "if (blocks.size >= 32 && !blocks.has(number)) fail('inspection_limit');",
    "if (false) fail('inspection_limit');",
    'media-webm-block-count-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'WebM bounds separately identified tracks and blocks',
    17,
  ),
  mediaControl(
    'MEDIA_OGG_COMMENT_COUNT_BOUND',
    'packages/shared/src/media-verifier-ogg.ts',
    "if (n > 65536) fail('inspection_limit');",
    "if (false) fail('inspection_limit');",
    'media-ogg-comment-count-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'Ogg comment count admits exactly 65536',
    17,
  ),
  mediaControl(
    'MEDIA_PDF_ID_HEX_BOUND',
    'packages/shared/src/media-verifier-pdf.ts',
    "if (out.length >= 256) fail('inspection_limit');",
    "if (false) fail('inspection_limit');",
    'media-pdf-id-hex-bound',
    'packages/shared/src/media-verifier-invalid.test.ts',
    'PDF bounds an admitted trailer ID hex token',
    17,
  ),
);
