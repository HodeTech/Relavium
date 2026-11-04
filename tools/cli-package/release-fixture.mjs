/**
 * Test-only release candidates (Step 9b.2). The synthetic sealed staging of `candidate-fixture.mjs`, sealed
 * with a real tarball digest, gives a synthetic-scope container; a copy whose manifest records a clean,
 * non-synthetic source gives a production-scope one (the container checks structure, not provenance).
 * Production-scope tests load a temporary recipient root, never the committed path, and never a fixture
 * key. Nothing here is a product; only tests import it.
 */
import { Buffer } from 'node:buffer';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidate, digest, fresh, seal } from './candidate-fixture.mjs';
import { buildPrivateContainer } from './container.mjs';

/** A synthetic tarball: its bytes are never inspected, only named and hashed. */
export const TARBALL = Buffer.from('a synthetic tarball, never a package\n');
export const VERSION = '0.1.1';
/** The clean, non-synthetic source the production-scope container records. */
export const CLEAN = Object.freeze({ commit: 'd'.repeat(40), tree: 'e'.repeat(40) });

/**
 * A container of a copy of `staging` whose manifest records `source`.
 * @param {string} staging @param {{commit: string, tree: string, dirty: boolean}} source
 */
export function containerWith(staging, source) {
  const copy = fresh('release-staging');
  cpSync(staging, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
  manifest.source = source;
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  return buildPrivateContainer(copy).bytes;
}

/**
 * The sealed synthetic staging, its container, and a clean one, all naming `TARBALL`'s digest.
 * @returns {Promise<{staging: string, synthetic: Buffer, clean: Buffer}>}
 */
export async function containers() {
  const fixture = await candidate();
  fixture.archive.sha256 = digest(TARBALL);
  await seal(fixture);
  writeFileSync(join(fixture.staging, 'metafile-esm.json'), '{"inputs":{},"outputs":{}}');
  return {
    staging: fixture.staging,
    synthetic: buildPrivateContainer(fixture.staging).bytes,
    clean: containerWith(fixture.staging, { ...CLEAN, dirty: false }),
  };
}

/** A fresh owner-only private root and a destination holding the candidate's tarball. */
export function places() {
  const root = fresh('release-root');
  mkdirSync(root);
  chmodSync(root, 0o700);
  const destination = fresh('release-destination');
  mkdirSync(destination);
  writeFileSync(join(destination, `relavium-${VERSION}.tgz`), TARBALL);
  return { root, destination };
}

/** A synthetic originating GitHub push run for `source`. @param {string} source */
export const origin = (source) => ({
  kind: 'github',
  repository: 'example/relavium',
  workflow: 'release',
  runId: '1',
  runAttempt: '1',
  event: 'push',
  source,
});

/**
 * A temporary production recipient root holding `file` and the given history.
 * @param {string} file
 * @param {{primary: string, subkey: string, status: string}[]} recipients
 */
export function recipientRoot(file, recipients) {
  const root = fresh('release-recipient');
  mkdirSync(root);
  copyFileSync(file, join(root, 'recipient.asc'));
  // The loader admits only the canonical serialization.
  writeFileSync(
    join(root, 'pins.json'),
    `${JSON.stringify({ version: 1, recipients }, null, 2)}\n`,
  );
  return root;
}
