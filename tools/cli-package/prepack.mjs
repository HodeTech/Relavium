/**
 * The CLI's sole prepack lifecycle (ADR-0111). It runs exactly one installed tsup build, then
 * either the ordinary map-free closure guard or — only when the trusted package producer names a
 * private staging directory — the candidate finalizer. pnpm packs only after this exits 0, and
 * nothing builds, transforms or writes the JS after it.
 */
import { AssertionError } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundleClosureError } from '../bundle-closure/closure.mjs';
import {
  CANDIDATE_STAGING_ENV,
  CandidateFinalizationError,
  assertPrivateStaging,
  finalizeCandidate,
} from './finalize.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repository, 'apps', 'cli');

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** @param {string} script @param {string} cwd */
function runNode(script, cwd) {
  const result = spawnSync(process.execPath, [script], { cwd, stdio: 'inherit', shell: false });
  return result.error === undefined && result.status === 0;
}

const staging = process.env[CANDIDATE_STAGING_ENV];
try {
  if (resolve(process.cwd()) !== cli) fail('CLI prepack must run in its package directory');
  // Refuse an unusable staging directory before anything is built.
  if (staging !== undefined) assertPrivateStaging(staging, repository);
  const tsupManifest = createRequire(join(cli, 'package.json')).resolve('tsup/package.json');
  const tsup = join(dirname(tsupManifest), JSON.parse(readFileSync(tsupManifest, 'utf8')).bin.tsup);
  if (!runNode(tsup, cli)) fail('CLI build failed');
  if (staging === undefined) {
    if (!runNode(join(repository, 'tools', 'bundle-closure', 'check.mjs'), repository)) {
      process.exit(1);
    }
  } else {
    const record = finalizeCandidate({ repository, staging });
    console.log(
      `✓ CLI candidate finalized: ${record.outputs.length} output(s), ` +
        `${record.maps.length} private map(s), ${record.upstreamMaps} upstream map(s)`,
    );
  }
} catch (error) {
  // Every known refusal carries a fixed code and at most a repository-relative path.
  if (error instanceof CandidateFinalizationError) fail(error.message);
  if (error instanceof BundleClosureError) fail(`CLI candidate closure: ${error.message}`);
  if (error instanceof AssertionError) fail(`CLI candidate finalization: ${error.message}`);
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED';
  fail(`CLI candidate finalization failed: ${code}`);
}
