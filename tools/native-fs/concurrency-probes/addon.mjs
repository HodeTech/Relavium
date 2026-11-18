// Shared helper of the concurrency probes: the built native addon, a private scratch home, and the staging index.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultLoader = fileURLToPath(
  new URL('../../../apps/cli/native/fs-metadata/runtime/loader.cjs', import.meta.url),
);

/** The addon built by `node tools/native-fs/build.mjs`; `RELAVIUM_NATIVE_LOADER` points at another build. */
export function loadAddon() {
  const loader = process.env.RELAVIUM_NATIVE_LOADER ?? defaultLoader;
  return createRequire(import.meta.url)(loader).loadFsMetadataAddon();
}

/** A private operator home and a destination directory in a fresh temporary directory. */
export function scratchHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-concurrency-probe-')));
  const home = join(root, 'home');
  const destination = join(root, 'destination');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  return {
    root,
    home,
    destination,
    index: join(home, '.relavium-fs-private-v1', 'fs-staging-v1'),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The positive integer at `position` (2 is the first, as in `process.argv`) among the arguments that are not
 * `--flags`, or `fallback` when it is omitted. Flags may stand anywhere, so `writers.mjs --recover` and
 * `writers.mjs 4 --recover` both work.
 */
export function integerArgument(position, fallback) {
  const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const value = Number(positional[position - 2] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`argument ${position} must be a positive integer`);
  return value;
}
