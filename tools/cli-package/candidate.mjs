/**
 * The owned isolated candidate tree (ADR-0111, Wave 3 Step 9a.1). A release-map build never runs in
 * the developer's workspace: the producer copies the exact listed source files of the original
 * checkout into a fresh private tree, installs the locked dependency closure there from the existing
 * content-addressed store without lifecycle scripts or network, and verifies that every workspace
 * link resolves inside that tree. No original workspace `dist` can stand in for freshly mapped
 * output, and no build cache is read or written.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ENGINE_PACKAGES } from './finalize.mjs';
import { readOrdinaryFile } from './files.mjs';
import { isolatedEnvironment, runCommand, runPnpm } from './process.mjs';

export const CANDIDATE_LIMITS = Object.freeze({
  files: 20_000,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
});

/** Only the variables pnpm uses to locate its store; never credentials, preloads or registries. */
const STORE_DISCOVERY_VARIABLES = Object.freeze([
  'HOME',
  'USERPROFILE',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'LOCALAPPDATA',
  'APPDATA',
  'PNPM_HOME',
]);

/** @param {string} parent @param {string} child */
function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** @param {string} output NUL-separated Git path list */
function gitPaths(output) {
  return output.split('\0').filter((path) => path !== '');
}

/** Names the developer's global Git excludes file for a producer whose own environment is isolated. */
export const GIT_EXCLUDES_ENV = 'RELAVIUM_GIT_EXCLUDES_FILE';

/** Only the variables Git uses to locate its global configuration; never credentials or hooks. */
const GIT_CONFIG_VARIABLES = Object.freeze([
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'SystemRoot',
  'WINDIR',
]);

/**
 * The developer's global Git excludes file, so that the candidate's isolated Git ignores what the
 * developer's own `git status` ignores: the explicit `RELAVIUM_GIT_EXCLUDES_FILE` when a caller
 * already isolated this process's environment, otherwise `core.excludesFile` as the developer's Git
 * reads it, else Git's default `$XDG_CONFIG_HOME/git/ignore` or `$HOME/.config/git/ignore`; undefined
 * when no such file exists. Only that location is read from the developer's configuration: every
 * candidate Git command keeps the isolated environment, so no global hook, fsmonitor or other setting
 * applies.
 * @param {{repository: string, environment: Record<string, string | undefined>, run?: typeof runCommand}} options
 * @returns {Promise<string | undefined>}
 */
export async function globalExcludesFile({ repository, environment, run = runCommand }) {
  const explicit = environment[GIT_EXCLUDES_ENV];
  if (explicit !== undefined) {
    assert.ok(isAbsolute(explicit) && existsSync(explicit), 'PACKED_CLI_GIT_EXCLUDES');
    return explicit;
  }
  const env = { PATH: environment.PATH ?? '' };
  for (const key of GIT_CONFIG_VARIABLES) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  let configured = '';
  try {
    configured = (
      await run('git', ['config', '--path', '--get', 'core.excludesFile'], { cwd: repository, env })
    ).stdout.trim();
  } catch (error) {
    // Git exits 1 when the setting is absent; anything else is a refusal.
    if (error?.result?.code !== 1) throw error;
  }
  const xdg = environment.XDG_CONFIG_HOME;
  const home = environment.HOME ?? environment.USERPROFILE;
  let path;
  if (configured !== '') path = resolve(repository, configured);
  else if (xdg !== undefined && xdg !== '') path = join(xdg, 'git', 'ignore');
  else if (home !== undefined && home !== '') path = join(home, '.config', 'git', 'ignore');
  return path !== undefined && existsSync(path) && statSync(path).isFile() ? path : undefined;
}

/** @param {string | undefined} excludes @returns {string[]} */
function excludesArguments(excludes) {
  return excludes === undefined ? [] : ['-c', `core.excludesFile=${excludes}`];
}

/**
 * The source identity of the original checkout: its exact commit and its full porcelain status, so
 * a candidate copied from a modified tree records `dirty` and a status change during the copy
 * refuses. Untracked files are judged with the developer's global excludes (`globalExcludesFile`).
 * @param {string} repository @param {typeof runCommand} [run] @param {string} [excludes]
 */
export async function sourceIdentity(repository, run = runCommand, excludes = undefined) {
  const options = { cwd: repository, env: isolatedEnvironment(repository) };
  const source = (
    await run('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], options)
  ).stdout.trim();
  assert.match(source, /^[0-9a-f]{40}$/u, 'PACKED_CLI_SOURCE_IDENTITY');
  const status = (
    await run(
      'git',
      [...excludesArguments(excludes), 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      options,
    )
  ).stdout;
  return { source, status, dirty: status !== '' };
}

/**
 * Every file Git would ship from the working tree: tracked plus untracked-but-not-ignored, minus
 * deletions, by the repository's ignore rules and the developer's global excludes
 * (`globalExcludesFile`). Ignored output, caches, dependencies and private notes never enter a
 * candidate.
 * @param {string} repository @param {typeof runCommand} [run] @param {string} [excludes]
 */
export async function candidateFiles(repository, run = runCommand, excludes = undefined) {
  const options = { cwd: repository, env: isolatedEnvironment(repository) };
  const listed = gitPaths(
    (
      await run(
        'git',
        [
          ...excludesArguments(excludes),
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
        ],
        options,
      )
    ).stdout,
  );
  const deleted = new Set(
    gitPaths((await run('git', ['ls-files', '-z', '--deleted'], options)).stdout),
  );
  const files = [...new Set(listed)].filter((path) => !deleted.has(path)).sort();
  assert.ok(
    files.length > 0 && files.length <= CANDIDATE_LIMITS.files,
    'PACKED_CLI_CANDIDATE_FILES',
  );
  return files;
}

/**
 * Copy each listed ordinary file byte-for-byte into the empty `destination`. Links, special files,
 * escaping or noncanonical paths and oversized trees refuse; only the executable bit is kept, as an
 * exact 0755 or 0644 mode whatever the process umask.
 * @param {{repository: string, destination: string, files: readonly string[]}} options
 */
export function copyCandidateTree({ repository, destination, files }) {
  assert.ok(
    isAbsolute(destination) && readdirSync(destination).length === 0,
    'PACKED_CLI_CANDIDATE_ROOT',
  );
  let total = 0;
  for (const path of files) {
    assert.ok(
      typeof path === 'string' &&
        path.length > 0 &&
        !path.includes('\\') &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'PACKED_CLI_CANDIDATE_PATH',
    );
    const source = join(repository, ...path.split('/'));
    const executable = (lstatSync(source).mode & 0o111) !== 0;
    const bytes = readOrdinaryFile(source, CANDIDATE_LIMITS.fileBytes);
    total += bytes.length;
    assert.ok(total <= CANDIDATE_LIMITS.totalBytes, 'PACKED_CLI_CANDIDATE_BYTES');
    const target = join(destination, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const mode = executable ? 0o755 : 0o644;
    writeFileSync(target, bytes, { flag: 'wx', mode });
    // The creation mode passes through the umask; the candidate keeps the exact mode.
    if (process.platform !== 'win32') chmodSync(target, mode);
  }
  return { files: files.length, bytes: total };
}

/** An explicit store directory, set by a caller that discovered it in its own environment. */
export const PACKAGE_STORE_ENV = 'RELAVIUM_PACKAGE_STORE_DIR';

/**
 * The developer's existing content-addressed dependency store: the explicit
 * `RELAVIUM_PACKAGE_STORE_DIR` when a caller already isolated this process's environment,
 * otherwise discovered by the pinned pnpm with only the store-location variables of `environment`.
 * Everything else — temporary files, caches, corepack state — goes to the private `home`, never
 * into the original checkout.
 * @param {{repository: string, environment: Record<string, string | undefined>, home: string,
 *   pnpm?: typeof runPnpm}} options
 */
export async function dependencyStore({ repository, environment, home, pnpm = runPnpm }) {
  const explicit = environment[PACKAGE_STORE_ENV];
  if (explicit !== undefined) {
    assert.ok(isAbsolute(explicit) && existsSync(explicit), 'PACKED_CLI_DEPENDENCY_STORE');
    return explicit;
  }
  assert.ok(isAbsolute(home) && !within(repository, home), 'PACKED_CLI_PRIVATE_HOME');
  const env = isolatedEnvironment(home);
  for (const key of STORE_DISCOVERY_VARIABLES) {
    if (environment[key] === undefined) delete env[key];
    else env[key] = environment[key];
  }
  const store = (await pnpm(['store', 'path'], { cwd: repository, env })).stdout.trim();
  assert.ok(isAbsolute(store) && existsSync(store), 'PACKED_CLI_DEPENDENCY_STORE');
  return store;
}

/**
 * Install the locked closure into the candidate from the store: offline, frozen and without any
 * lifecycle script, because building or packing the CLI never loads a native module.
 * @param {{candidate: string, store: string, env: Record<string, string>, pnpm: typeof runPnpm}} options
 */
export async function installCandidateDependencies({ candidate, store, env, pnpm }) {
  await pnpm(
    ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--store-dir', store],
    { cwd: candidate, env },
  );
}

/**
 * Every workspace link must resolve inside the candidate, never to the original checkout whose
 * `dist` is map-free and possibly stale.
 * @param {string} candidate
 */
export function verifyCandidateLinks(candidate) {
  const root = realpathSync(candidate);
  for (const name of ENGINE_PACKAGES) {
    const link = join(root, 'apps', 'cli', 'node_modules', '@relavium', name);
    let info;
    try {
      info = lstatSync(link);
    } catch {
      assert.fail('PACKED_CLI_CANDIDATE_LINK');
    }
    assert.ok(info.isSymbolicLink(), 'PACKED_CLI_CANDIDATE_LINK');
    assert.equal(realpathSync(link), join(root, 'packages', name), 'PACKED_CLI_CANDIDATE_LINK');
  }
  for (const workspace of [
    join('apps', 'cli'),
    ...ENGINE_PACKAGES.map((name) => join('packages', name)),
  ]) {
    const scope = join(root, workspace, 'node_modules', '@relavium');
    if (!existsSync(scope)) continue;
    for (const name of readdirSync(scope)) {
      assert.ok(ENGINE_PACKAGES.includes(name), 'PACKED_CLI_CANDIDATE_LINK');
      assert.equal(
        realpathSync(join(scope, name)),
        join(root, 'packages', name),
        'PACKED_CLI_CANDIDATE_LINK',
      );
    }
  }
  assert.ok(within(root, realpathSync(join(root, 'node_modules'))), 'PACKED_CLI_CANDIDATE_LINK');
}

/**
 * No build cache may exist in the candidate after its build: Turbo state, TypeScript incremental
 * files or a tool cache would let a later build read candidate output or a broad capture keep it.
 * Dependency directories themselves are installation state and are not walked.
 * @param {string} candidate
 */
export function assertNoBuildCache(candidate) {
  const found = [];
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name === '.turbo' || entry.name.endsWith('.tsbuildinfo')) found.push(path);
      else if (entry.isDirectory() && entry.name === 'node_modules') {
        if (existsSync(join(directory, entry.name, '.cache'))) found.push(`${path}/.cache`);
      } else if (entry.isDirectory()) visit(join(directory, entry.name), path);
    }
  }
  visit(candidate, '');
  assert.deepEqual(found, [], 'PACKED_CLI_CANDIDATE_BUILD_CACHE');
}

/**
 * Prepare the owned candidate: capture the original checkout's identity, copy its listed files,
 * refuse if that identity changed during the copy, install the locked closure and verify every
 * workspace link. The returned identity is what the candidate is later sealed with.
 * @param {{repository: string, candidate: string, environment: Record<string, string | undefined>,
 *   home: string, env: Record<string, string>, excludes?: string, run?: typeof runCommand,
 *   pnpm?: typeof runPnpm}} options
 *   `env` is the isolated environment of the private `home`; `excludes` is the developer's global
 *   Git excludes file (`globalExcludesFile`).
 */
export async function prepareCandidate({
  repository,
  candidate,
  environment,
  home,
  env,
  excludes = undefined,
  run = runCommand,
  pnpm = runPnpm,
}) {
  const identity = await sourceIdentity(repository, run, excludes);
  const copied = copyCandidateTree({
    repository,
    destination: candidate,
    files: await candidateFiles(repository, run, excludes),
  });
  const after = await sourceIdentity(repository, run, excludes);
  assert.ok(
    after.source === identity.source && after.status === identity.status,
    'PACKED_CLI_SOURCE_CHANGED_DURING_COPY',
  );
  const store = await dependencyStore({ repository, environment, home, pnpm });
  await installCandidateDependencies({ candidate, store, env, pnpm });
  verifyCandidateLinks(candidate);
  return { source: identity.source, dirty: identity.dirty, files: copied.files };
}
