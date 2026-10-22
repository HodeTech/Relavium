/** Thin filesystem/exit adapter for the ADR-0111 emitted ESM graph guard of an ordinary build. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundleClosureError, checkBundleClosure } from './closure.mjs';
import { MODE_EVIDENCE, emittedInventory } from './inventory.mjs';

const packageDirectory = fileURLToPath(new URL('../../apps/cli/', import.meta.url));

try {
  // An ordinary build is map-free: its metafile is the only unpublished file it may leave in dist.
  const report = checkBundleClosure({
    metafile: JSON.parse(readFileSync(join(packageDirectory, 'dist/metafile-esm.json'), 'utf8')),
    manifest: JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')),
    files: emittedInventory(packageDirectory, { privateFiles: ['metafile-esm.json'] }),
    modeEvidence: MODE_EVIDENCE,
    maps: 'none',
  });
  console.log(
    `✓ CLI finite ESM closure: ${report.outputs.length} output(s), ${report.inputs.length} input(s), ` +
      `${report.dependencies.length} declared external dependencies; engine inlined; map-free; ` +
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
