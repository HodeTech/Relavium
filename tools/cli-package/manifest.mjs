/**
 * The private map manifest (ADR-0111; packaging.md, "private map manifest"; Step 9a.2a). Sealed into
 * private staging only after the archive inspection, it binds the source commit and its tree, the
 * package version, the toolchain and target, the lock and build-configuration digests, every final JS
 * file as `dist/<chunk>.js` with its map, a digest of every original source a final map names, and the
 * tarball digest. It holds no host path, credential or source content, and it is removed with the
 * staging; Step 9b carries it into ciphertext.
 */
import { Buffer } from 'node:buffer';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPackageVersion } from './binding.mjs';
import { ENGINE_PACKAGES, writePrivateFile } from './finalize.mjs';
import { readOrdinaryFile, sha256 } from './files.mjs';
import { isolatedGitEnvironment, runCommand } from './process.mjs';

export const MANIFEST_FILE = 'manifest.json';

/**
 * The candidate files whose bytes decide the build: the lock, every package manifest, and every build
 * configuration with the configurations it extends.
 */
export const MANIFEST_INPUTS = Object.freeze([
  '.npmrc',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'apps/cli/package.json',
  'apps/cli/tsconfig.json',
  'apps/cli/tsup.config.ts',
  ...ENGINE_PACKAGES.flatMap((name) => [
    `packages/${name}/package.json`,
    `packages/${name}/tsconfig.json`,
    `packages/${name}/tsconfig.build.json`,
  ]),
  'packages/core/tsconfig.purity.json',
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40}$/u;
const OUTPUT = /^dist\/[A-Za-z0-9_-]+\.js$/u;
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9_.-]*';
/** A repository-relative original source the finalizer admits: CLI or engine TypeScript. */
const SOURCE = new RegExp(
  `^(?:apps/cli|packages/(?:${ENGINE_PACKAGES.join('|')}))/src/(?:${SEGMENT}/)*${SEGMENT}\\.tsx?$`,
  'u',
);
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/u;
const LIMITS = Object.freeze({ outputs: 256, sources: 8192, recordBytes: 1024 * 1024 });
/**
 * The size bound each staged record's reader applies, by file name: no record in the custody container
 * exceeds the size its reader accepts.
 */
export const RECORD_BYTES = Object.freeze({
  'finalized.json': LIMITS.recordBytes,
  [MANIFEST_FILE]: LIMITS.recordBytes * 4,
  'metafile-esm.json': 4 * 1024 * 1024,
});

export class ManifestError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`PACKED_CLI_MANIFEST_${code}`);
    this.name = 'ManifestError';
    this.code = code;
  }
}

/** @param {string} code @returns {never} */
function refuse(code) {
  throw new ManifestError(code);
}

/** @param {string} root @param {string} path repository-relative POSIX path @param {number} limit */
function read(root, path, limit) {
  try {
    return readOrdinaryFile(join(root, ...path.split('/')), limit);
  } catch {
    refuse('UNREADABLE_INPUT');
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @typedef {{version: 1, source: {commit: string, tree: string, dirty: boolean},
 *   packageVersion: string, target: string,
 *   toolchain: {node: string, pnpm: string, typescript: string, tsup: string, esbuild: string},
 *   inputs: Record<string, string>,
 *   outputs: {path: string, sha256: string, map: {path: string, sha256: string}}[],
 *   sources: Record<string, string>, tarballSha256: string}} PrivateManifest
 */

/**
 * Validate a manifest's exact shape. Every key is fixed, every digest is SHA-256 hex, every path is
 * repository- or package-relative, and the outputs and sources are sorted and unique.
 * @param {unknown} value
 * @returns {PrivateManifest}
 */
export function validateManifest(value) {
  const exact = (record, keys) =>
    isRecord(record) && isDeepStrictEqual(Object.keys(record).sort(), [...keys].sort());
  if (
    !exact(value, [
      'version',
      'source',
      'packageVersion',
      'target',
      'toolchain',
      'inputs',
      'outputs',
      'sources',
      'tarballSha256',
    ]) ||
    value.version !== 1
  ) {
    refuse('SHAPE');
  }
  const { source, toolchain, inputs, outputs, sources } = value;
  if (
    !exact(source, ['commit', 'tree', 'dirty']) ||
    !GIT_OBJECT.test(String(source.commit)) ||
    !GIT_OBJECT.test(String(source.tree)) ||
    typeof source.dirty !== 'boolean' ||
    !isPackageVersion(value.packageVersion) ||
    typeof value.target !== 'string' ||
    !/^node\d{2,3}$/u.test(value.target) ||
    !exact(toolchain, ['node', 'pnpm', 'typescript', 'tsup', 'esbuild']) ||
    !/^v\d+\.\d+\.\d+$/u.test(String(toolchain.node)) ||
    toolchain.pnpm !== '9.12.3' ||
    !['typescript', 'tsup', 'esbuild'].every((name) => VERSION.test(String(toolchain[name]))) ||
    !exact(inputs, MANIFEST_INPUTS) ||
    !Object.values(inputs).every((digest) => SHA256.test(String(digest))) ||
    typeof value.tarballSha256 !== 'string' ||
    !SHA256.test(value.tarballSha256)
  ) {
    refuse('SHAPE');
  }
  if (
    !Array.isArray(outputs) ||
    outputs.length === 0 ||
    outputs.length > LIMITS.outputs ||
    !outputs.every(
      (output, index) =>
        exact(output, ['path', 'sha256', 'map']) &&
        OUTPUT.test(String(output.path)) &&
        SHA256.test(String(output.sha256)) &&
        exact(output.map, ['path', 'sha256']) &&
        output.map.path === `${output.path}.map` &&
        SHA256.test(String(output.map.sha256)) &&
        (index === 0 || outputs[index - 1].path < output.path),
    )
  ) {
    refuse('SHAPE');
  }
  const names = isRecord(sources) ? Object.keys(sources) : [];
  if (
    !isRecord(sources) ||
    names.length === 0 ||
    names.length > LIMITS.sources ||
    !names.every(
      (name, index) =>
        SOURCE.test(name) &&
        SHA256.test(String(sources[name])) &&
        (index === 0 || names[index - 1] < name),
    )
  ) {
    refuse('SHAPE');
  }
  return /** @type {PrivateManifest} */ (value);
}

/**
 * Seal the private manifest into `staging`, after the archive inspection has proven the tarball's
 * JS byte-equal to the finalized files. The staged maps must still be the bytes the finalizer
 * recorded, and each recorded JS digest must be the tarball entry's. An existing manifest refuses.
 * @param {{candidate: string, staging: string, checkout: string, source: string, dirty: boolean,
 *   archive: {sha256: string, files: {path: string, sha256: string}[], package: {version: string}},
 *   run?: typeof runCommand}} options
 * @returns {Promise<PrivateManifest>}
 */
export async function sealPrivateManifest({
  candidate,
  staging,
  checkout,
  source,
  dirty,
  archive,
  run = runCommand,
}) {
  let record;
  try {
    record = JSON.parse(
      readOrdinaryFile(join(staging, 'finalized.json'), RECORD_BYTES['finalized.json']).toString(
        'utf8',
      ),
    );
  } catch {
    refuse('RECORD');
  }
  if (!isRecord(record) || !Array.isArray(record.outputs) || !Array.isArray(record.maps)) {
    refuse('RECORD');
  }
  const maps = new Map(record.maps.map((map) => [isRecord(map) ? map.path : undefined, map]));
  const packed = new Map(archive.files.map((file) => [file.path, file.sha256]));
  const named = new Set();
  const outputs = record.outputs.map((output) => {
    const map = isRecord(output) ? maps.get(`${output.path}.map`) : undefined;
    if (!isRecord(output) || !isRecord(map) || !OUTPUT.test(String(output.path))) refuse('RECORD');
    const bytes = read(staging, `maps/${basename(output.path)}.map`, 16 * 1024 * 1024);
    if (bytes.length !== map.bytes || sha256(bytes) !== map.sha256) refuse('MAP_DRIFT');
    if (packed.get(`package/${output.path}`) !== output.sha256) refuse('TARBALL_DRIFT');
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      refuse('MAP_DRIFT');
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sources)) refuse('MAP_DRIFT');
    for (const name of parsed.sources) named.add(name);
    return {
      path: output.path,
      sha256: output.sha256,
      map: { path: map.path, sha256: map.sha256 },
    };
  });
  if (maps.size !== outputs.length) refuse('RECORD');
  outputs.sort((left, right) => (left.path < right.path ? -1 : 1));
  const sources = Object.fromEntries(
    [...named]
      .map(String)
      .sort()
      .map((name) => {
        if (!SOURCE.test(name)) refuse('SOURCE_PATH');
        return [name, sha256(read(candidate, name, 8 * 1024 * 1024))];
      }),
  );
  let tree;
  try {
    tree = (
      await run('git', ['--no-replace-objects', 'rev-parse', '--verify', `${source}^{tree}`], {
        cwd: checkout,
        env: isolatedGitEnvironment(),
        timeoutMs: 60_000,
      })
    ).stdout.trim();
  } catch {
    refuse('SOURCE_TREE');
  }
  if (!GIT_OBJECT.test(tree)) refuse('SOURCE_TREE');
  const cli = createRequire(join(candidate, 'apps', 'cli', 'package.json'));
  const version = (require, name) => {
    try {
      return String(require(`${name}/package.json`).version);
    } catch {
      refuse('TOOLCHAIN');
    }
  };
  const toolchain = {
    node: process.version,
    pnpm: '9.12.3',
    typescript: version(cli, 'typescript'),
    tsup: version(cli, 'tsup'),
    esbuild: version(createRequire(cli.resolve('tsup/package.json')), 'esbuild'),
  };
  const targets = [
    ...read(candidate, 'apps/cli/tsup.config.ts', 128 * 1024)
      .toString('utf8')
      .matchAll(/^ {2}target: '([^']+)',$/gmu),
  ];
  if (targets.length !== 1) refuse('TARGET');
  const manifest = validateManifest({
    version: 1,
    source: { commit: source, tree, dirty },
    packageVersion: archive.package.version,
    target: targets[0][1],
    toolchain,
    inputs: Object.fromEntries(
      MANIFEST_INPUTS.map((path) => [path, sha256(read(candidate, path, 16 * 1024 * 1024))]),
    ),
    outputs,
    sources,
    tarballSha256: archive.sha256,
  });
  writePrivateFile(
    join(staging, MANIFEST_FILE),
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
  );
  return manifest;
}

/**
 * Verify that the finalized `dist` and the tarball are still the ones `manifest` records: exactly its
 * outputs, each with its digest, and the tarball's digest (ADR-0111's post-receipt rebuild refusal;
 * Step 9a.2b). The seal runs it with the manifest it has just sealed, after symbolication and
 * immediately before the receipt is written, so a `dist` rebuilt or changed after the inspection — in
 * a chunk no frame lands in as well — refuses.
 * @param {{candidate: string, manifest: PrivateManifest, tarball: string}} options
 */
export function verifySealedDist({ candidate, manifest, tarball }) {
  const cli = join(candidate, 'apps', 'cli');
  let names;
  try {
    names = readdirSync(join(cli, 'dist')).sort();
  } catch {
    refuse('DIST_DRIFT');
  }
  const expected = manifest.outputs.map((output) => basename(output.path)).sort();
  if (!isDeepStrictEqual(names, expected)) refuse('DIST_DRIFT');
  for (const output of manifest.outputs) {
    let bytes;
    try {
      bytes = readOrdinaryFile(join(cli, ...output.path.split('/')), 8 * 1024 * 1024);
    } catch {
      refuse('DIST_DRIFT');
    }
    if (sha256(bytes) !== output.sha256) refuse('DIST_DRIFT');
  }
  let packed;
  try {
    packed = readOrdinaryFile(tarball, 16 * 1024 * 1024);
  } catch {
    refuse('TARBALL_CHANGED');
  }
  if (sha256(packed) !== manifest.tarballSha256) refuse('TARBALL_CHANGED');
}

/**
 * Read and validate the sealed manifest from `staging`.
 * @param {string} staging
 * @returns {PrivateManifest}
 */
export function readPrivateManifest(staging) {
  let value;
  try {
    value = JSON.parse(
      readOrdinaryFile(join(staging, MANIFEST_FILE), RECORD_BYTES[MANIFEST_FILE]).toString('utf8'),
    );
  } catch {
    refuse('UNREADABLE');
  }
  return validateManifest(value);
}
