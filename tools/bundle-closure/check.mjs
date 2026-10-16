/** Thin filesystem/exit adapter for the ADR-0111 emitted ESM graph guard. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundleClosureError, checkBundleClosure } from './closure.mjs';

const modeEvidence = process.platform === 'win32' ? 'not-observable-windows' : 'posix';
const packageDirectory = fileURLToPath(new URL('../../apps/cli/', import.meta.url));

function inventory(directory, files = {}) {
  if (!lstatSync(directory).isDirectory()) {
    throw new BundleClosureError('OUTPUT_KIND', 'dist inventory must use ordinary directories');
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inventory(path, files);
    else if (/\.(?:js|mjs|cjs)$/iu.test(entry.name)) {
      const key = relative(packageDirectory, path).split(sep).join('/');
      const stat = lstatSync(path);
      files[key] = {
        contents: entry.isFile() ? readFileSync(path, 'utf8') : '',
        ...(modeEvidence === 'posix' ? { mode: stat.mode & 0o7777 } : {}),
        kind: entry.isFile() ? 'file' : 'other',
      };
    } else if (entry.isSymbolicLink()) {
      // Never follow a directory symlink that could hide runtime chunks.
      throw new BundleClosureError('OUTPUT_KIND', 'dist contains a symbolic link');
    }
  }
  return files;
}

try {
  const report = checkBundleClosure({
    metafile: JSON.parse(readFileSync(join(packageDirectory, 'dist/metafile-esm.json'), 'utf8')),
    manifest: JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')),
    files: inventory(join(packageDirectory, 'dist')),
    modeEvidence,
  });
  console.log(
    `✓ CLI finite ESM closure: ${report.outputs.length} output(s), ${report.inputs.length} input(s), ` +
      `${report.dependencies.length} declared external dependencies; engine inlined; ` +
      (report.modeEvidence === 'posix'
        ? 'POSIX modes verified.'
        : 'POSIX modes not observable on Windows (graph evidence only).'),
  );
} catch (error) {
  console.error(
    error instanceof BundleClosureError
      ? `✗ CLI bundle closure: ${error.message}`
      : '✗ CLI bundle closure: cannot read valid build inventory — build the CLI first.',
  );
  process.exitCode = 1;
}
