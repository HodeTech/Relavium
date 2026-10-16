import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARCHIVE_LIMITS, inspectPackageArchive } from './archive.mjs';
import {
  aggregateConsumers,
  originFromEnvironment,
  PackageBindingError,
  requirePackageJobResults,
  validatePackageReceipt,
} from './binding.mjs';

/** @param {string} path @param {number} maximum */
function boundedFile(path, maximum) {
  if (!lstatSync(path).isFile()) throw new PackageBindingError('INPUT_FILE');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) throw new PackageBindingError('INPUT_SIZE');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw new PackageBindingError('INPUT_CHANGED');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

/** @param {string} path */
function directory(path) {
  if (!lstatSync(path).isDirectory()) throw new PackageBindingError('INPUT_DIRECTORY');
  return readdirSync(path);
}

/** @param {string[]} args @param {Record<string, string | undefined>} environment */
export function runAggregate(args, environment) {
  if (args.length !== 2 || !args[0] || !args[1]) throw new PackageBindingError('ARGUMENTS');
  const artifactDirectory = resolve(args[0]);
  const reportsDirectory = resolve(args[1]);
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const source =
    environment.RELAVIUM_PACKAGE_SOURCE_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
    }).trim();
  const runtime = boundedFile(join(repository, '.nvmrc'), 20).toString('utf8').trim();
  if (!/^\d+$/u.test(runtime)) throw new PackageBindingError('RUNTIME');
  const expected = {
    source,
    origin: originFromEnvironment(environment),
    nodeMajor: Number(runtime),
  };
  requirePackageJobResults(JSON.parse(environment.RELAVIUM_PACKAGE_JOB_RESULTS ?? 'null'));
  const artifactNames = directory(artifactDirectory);
  const receipt = validatePackageReceipt(
    JSON.parse(
      boundedFile(join(artifactDirectory, 'package-test-receipt.json'), 512 * 1024).toString(
        'utf8',
      ),
    ),
    expected,
  );
  if (
    artifactNames.length !== 2 ||
    !artifactNames.includes(receipt.tarball) ||
    !artifactNames.includes('package-test-receipt.json')
  )
    throw new PackageBindingError('ARTIFACT_FILES');
  const tarball = boundedFile(
    join(artifactDirectory, receipt.tarball),
    ARCHIVE_LIMITS.compressedBytes,
  );
  const archive = inspectPackageArchive(tarball, {
    expectedFiles: new Map(
      receipt.files.map((file) => [file.path, { sha256: file.sha256, bytes: file.bytes }]),
    ),
    expectedPackage: receipt.package,
  });
  if (archive.sha256 !== receipt.tarballSha256 || archive.bytes !== receipt.archiveBytes)
    throw new PackageBindingError('ARTIFACT_BINDING');
  const folders = directory(reportsDirectory);
  if (folders.length !== 4) throw new PackageBindingError('REPORT_COUNT');
  const reports = folders.map((folder) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(folder)) throw new PackageBindingError('REPORT_DIRECTORY');
    const path = join(reportsDirectory, folder);
    const names = directory(path);
    if (names.length !== 1 || names[0] !== 'installed-consumer.json')
      throw new PackageBindingError('REPORT_FILES');
    return JSON.parse(boundedFile(join(path, names[0]), 512 * 1024).toString('utf8'));
  });
  return aggregateConsumers(receipt, reports, expected);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(runAggregate(process.argv.slice(2), process.env)));
  } catch (error) {
    console.error(
      error instanceof PackageBindingError
        ? error.message
        : 'CLI package aggregation refused: INPUT_INVALID',
    );
    process.exitCode = 1;
  }
}
