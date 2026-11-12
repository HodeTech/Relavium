/** Own-run immutable artifact locators; native bytes/profile/source checks supply admission. */
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readOrdinaryFile } from '../cli-package/files.mjs';
import { writeNativeAssets } from './assets.mjs';
import { checkNativeTarget } from './check-target.mjs';
import { NATIVE_DIRECTORY, NATIVE_TARGETS } from './catalog.mjs';

export const ARTIFACT_LIMITS = Object.freeze({
  candidates: 256,
  attempts: 32,
  envelopeBytes: 1024,
});
export class NativeArtifactError extends Error {
  constructor(code) {
    super(`NATIVE_FS_ARTIFACT_${code}`);
    this.name = 'NativeArtifactError';
    this.code = code;
  }
}
const refuse = (code) => {
  throw new NativeArtifactError(code);
};
const positive = (value) =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,15}$/u.test(value) &&
  Number.isSafeInteger(Number(value));
function identity(environment) {
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sourceSha } = environment;
  if (!positive(runId) || !positive(attempt) || !/^[0-9a-f]{40}$/u.test(sourceSha ?? ''))
    refuse('CONTEXT');
  return { version: 1, runId, attempt, sourceSha };
}
function ordinaryDirectory(path) {
  if (!lstatSync(path).isDirectory()) refuse('DIRECTORY');
}

export function stageNativeArtifact({
  repository,
  destination,
  target,
  environment = process.env,
}) {
  const context = identity(environment);
  const checked = checkNativeTarget(repository, target);
  mkdirSync(destination, { recursive: false });
  writeNativeAssets(
    join(destination, 'assets'),
    checked.manifest,
    new Map([...checked.files].filter(([name]) => name !== 'native-assets.json')),
  );
  writeFileSync(join(destination, 'delivery.json'), JSON.stringify({ ...context, target }) + '\n', {
    flag: 'wx',
    mode: 0o644,
  });
}

/** Validate every separated candidate before selecting the newest producer per requested target. */
export function selectNativeArtifacts({
  repository,
  inputs,
  targets = NATIVE_TARGETS,
  environment = process.env,
}) {
  const context = identity(environment);
  if (
    !Array.isArray(targets) ||
    targets.length < 1 ||
    new Set(targets).size !== targets.length ||
    targets.some((target) => !NATIVE_TARGETS.includes(target))
  )
    refuse('TARGETS');
  ordinaryDirectory(inputs);
  const names = readdirSync(inputs).sort();
  if (names.length < 1 || names.length > ARTIFACT_LIMITS.candidates) refuse('CANDIDATE_BOUND');
  const selected = new Map();
  const identities = new Set();
  const attempts = new Set();
  for (const name of names) {
    if (name.length > 128) refuse('NAME');
    const match = /^native-fs-([1-9][0-9]{0,15})-([1-9][0-9]{0,15})-([a-z0-9_-]+)$/u.exec(name);
    if (
      match === null ||
      !positive(match[1]) ||
      !positive(match[2]) ||
      !NATIVE_TARGETS.includes(match[3])
    )
      refuse('NAME');
    const [, runId, attempt, target] = match;
    if (runId !== context.runId || Number(attempt) > Number(context.attempt)) refuse('IDENTITY');
    const key = `${attempt}-${target}`;
    if (identities.has(key)) refuse('AMBIGUOUS');
    identities.add(key);
    attempts.add(attempt);
    if (attempts.size > ARTIFACT_LIMITS.attempts) refuse('ATTEMPT_BOUND');
    const directory = join(inputs, name);
    ordinaryDirectory(directory);
    if (!isDeepStrictEqual(readdirSync(directory).sort(), ['assets', 'delivery.json']))
      refuse('INVENTORY');
    const envelopePath = join(directory, 'delivery.json');
    if (lstatSync(envelopePath).nlink !== 1) refuse('ENVELOPE');
    let envelope;
    try {
      envelope = JSON.parse(
        readOrdinaryFile(envelopePath, ARTIFACT_LIMITS.envelopeBytes).toString('utf8'),
      );
    } catch {
      refuse('ENVELOPE');
    }
    if (!isDeepStrictEqual(envelope, { ...context, attempt, target })) refuse('IDENTITY');
    const assetDirectory = join(directory, 'assets');
    // A valid newer receipt must not hide any corrupt/stale/foreign older candidate.
    const checked = checkNativeTarget(repository, target, assetDirectory);
    if (
      targets.includes(target) &&
      (!selected.has(target) || Number(selected.get(target).attempt) < Number(attempt))
    )
      selected.set(target, { attempt, checked });
  }
  if (targets.some((target) => !selected.has(target))) refuse('INCOMPLETE');
  return targets.map((target) => ({ target, ...selected.get(target) }));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const [command, path, target] = process.argv.slice(2);
  if (command === 'stage' && path !== undefined && target === undefined)
    stageNativeArtifact({
      repository,
      destination: resolve(path),
      target: process.env.RELAVIUM_EXPECTED_NATIVE_TARGET,
    });
  else if (
    command === 'select' &&
    path !== undefined &&
    NATIVE_TARGETS.includes(target) &&
    process.argv.length === 5
  ) {
    const [{ checked }] = selectNativeArtifacts({
      repository,
      inputs: resolve(path),
      targets: [target],
    });
    writeNativeAssets(
      join(repository, 'apps/cli', NATIVE_DIRECTORY),
      checked.manifest,
      new Map([...checked.files].filter(([name]) => name !== 'native-assets.json')),
    );
  } else refuse('ARGUMENTS');
}
