/**
 * The owned isolated candidate tree (ADR-0111, Wave 3 Step 9a.1). A release-map build never runs in
 * the developer's workspace: the producer copies the exact listed source files of the original
 * checkout into a fresh private tree, installs the locked dependency closure there from the existing
 * content-addressed store without lifecycle scripts or network, and verifies that every workspace
 * link resolves inside that tree. No original workspace `dist` can stand in for freshly mapped
 * output, and no build cache is read or written.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ENGINE_PACKAGES } from './finalize.mjs';
import { readOrdinaryFile } from './files.mjs';
import { within } from './paths.mjs';
import {
  GIT_NULL_DEVICE,
  isolatedEnvironment,
  isolatedGitEnvironment,
  runCommand,
  runPnpm,
} from './process.mjs';

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
  'npm_config_store_dir',
  'NPM_CONFIG_STORE_DIR',
]);

/** @param {string} output NUL-separated Git path list */
function gitPaths(output) {
  return output.split('\0').filter((path) => path !== '');
}

/** Names the developer's global Git excludes file for a producer whose own environment is isolated. */
export const GIT_EXCLUDES_ENV = 'RELAVIUM_GIT_EXCLUDES_FILE';

/**
 * Only the variables Git uses to locate its global configuration, plus the command-scope configuration
 * the developer's Git takes from the environment (`GIT_CONFIG_COUNT` with its `GIT_CONFIG_KEY_n` and
 * `GIT_CONFIG_VALUE_n`, and `GIT_CONFIG_PARAMETERS`); never credentials or hooks. They reach only the
 * read-only lookup of `core.excludesFile`, which runs nothing.
 */
const GIT_CONFIG_VARIABLES = Object.freeze([
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'SystemRoot',
  'WINDIR',
]);
const GIT_CONFIG_ENTRY = /^GIT_CONFIG_(?:KEY|VALUE)_(?:0|[1-9][0-9]{0,3})$/u;

/**
 * The developer's global Git excludes file, so that the candidate's isolated Git ignores what the
 * developer's own `git status` ignores: the explicit `RELAVIUM_GIT_EXCLUDES_FILE` when a caller
 * already isolated this process's environment, otherwise `core.excludesFile` as the developer's Git
 * reads it (present but empty: none, as Git then applies no global excludes), else, when the setting
 * is absent, Git's default `$XDG_CONFIG_HOME/git/ignore` or `$HOME/.config/git/ignore`; undefined
 * when no such file exists. Only that location is read from the developer's configuration: every
 * candidate Git command runs without global or system configuration (`isolatedGitEnvironment`), so no
 * global hook, fsmonitor or other setting applies, wherever it is stored.
 * @param {{repository: string, environment: Record<string, string | undefined>, run?: typeof runCommand}} options
 * @returns {Promise<string | undefined>}
 */
export async function globalExcludesFile({ repository, environment, run = runCommand }) {
  const explicit = environment[GIT_EXCLUDES_ENV];
  if (explicit !== undefined) {
    assert.ok(isAbsolute(explicit) && existsSync(explicit), 'PACKED_CLI_GIT_EXCLUDES');
    return explicit;
  }
  // No PATH means no PATH: an empty one would make the spawn look the command up in the checkout.
  const env = environment.PATH === undefined ? {} : { PATH: environment.PATH };
  for (const key of GIT_CONFIG_VARIABLES) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    if (GIT_CONFIG_ENTRY.test(key) && value !== undefined) env[key] = value;
  }
  let configured;
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
  // A setting present but empty disables Git's global excludes; only an absent one has a default.
  if (configured !== undefined)
    path = configured === '' ? undefined : resolve(repository, configured);
  else if (xdg !== undefined && xdg !== '') path = join(xdg, 'git', 'ignore');
  else if (home !== undefined && home !== '') path = join(home, '.config', 'git', 'ignore');
  return path !== undefined && existsSync(path) && statSync(path).isFile() ? path : undefined;
}

/**
 * The environment of a producer that a caller has isolated: `base` plus the dependency store and, when
 * the caller found one, the developer's global Git excludes file, both found in the caller's own
 * environment (`dependencyStore`, `globalExcludesFile`).
 * @param {Record<string, string>} base
 * @param {{store: string, excludes?: string}} found
 * @returns {Record<string, string>}
 */
export function producerEnvironment(base, { store, excludes }) {
  return {
    ...base,
    [PACKAGE_STORE_ENV]: store,
    ...(excludes === undefined ? {} : { [GIT_EXCLUDES_ENV]: excludes }),
  };
}

/**
 * The attributes and excludes files a checkout-reading Git uses, named explicitly so that no default
 * location applies — not even one Git derives from the null-device home on Windows.
 * @param {string | undefined} excludes @returns {string[]}
 */
function readArguments(excludes) {
  return [
    '-c',
    `core.attributesFile=${GIT_NULL_DEVICE}`,
    '-c',
    `core.excludesFile=${excludes ?? GIT_NULL_DEVICE}`,
  ];
}

/**
 * The tracked paths whose working-tree changes `git status` cannot see: entries marked skip-worktree
 * (`S`) or assume-unchanged (a lowercase tag) in `git ls-files -v`.
 * @param {string} output NUL-separated `git ls-files -v -z` entries
 */
function uncheckedPaths(output) {
  return gitPaths(output)
    .filter((entry) => entry[0] === 'S' || /^[a-z]$/u.test(entry[0]))
    .map((entry) => entry.slice(2));
}

/**
 * The source identity of the original checkout: its exact commit, its full porcelain status and the
 * tracked files Git is told not to check, so a candidate copied from a modified tree records `dirty`
 * and a change to any of the three during the copy refuses. A skip-worktree or assume-unchanged file
 * counts as dirty whatever its bytes, since its copy is never compared with the commit. Untracked
 * files are judged with the developer's global excludes (`globalExcludesFile`).
 * @param {string} repository @param {typeof runCommand} [run] @param {string} [excludes]
 */
export async function sourceIdentity(repository, run = runCommand, excludes = undefined) {
  const options = { cwd: repository, env: isolatedGitEnvironment() };
  const source = (
    await run('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], options)
  ).stdout.trim();
  assert.match(source, /^[0-9a-f]{40}$/u, 'PACKED_CLI_SOURCE_IDENTITY');
  const status = (
    await run(
      'git',
      [...readArguments(excludes), 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      options,
    )
  ).stdout;
  const unchecked = uncheckedPaths((await run('git', ['ls-files', '-v', '-z'], options)).stdout);
  return { source, status, unchecked, dirty: status !== '' || unchecked.length > 0 };
}

/**
 * Every file Git would ship from the working tree: tracked plus untracked-but-not-ignored, minus
 * deletions, by the repository's ignore rules and the developer's global excludes
 * (`globalExcludesFile`). Ignored output, caches, dependencies and private notes never enter a
 * candidate; an untracked nested repository, which Git lists only as its directory, refuses.
 * @param {string} repository @param {typeof runCommand} [run] @param {string} [excludes]
 * @param {{files: number}} [limits] the bounds (`CANDIDATE_LIMITS`; smaller ones in tests)
 */
export async function candidateFiles(
  repository,
  run = runCommand,
  excludes = undefined,
  limits = CANDIDATE_LIMITS,
) {
  const options = { cwd: repository, env: isolatedGitEnvironment() };
  const listed = gitPaths(
    (
      await run(
        'git',
        [
          ...readArguments(excludes),
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
  // Git lists an untracked nested repository as its directory (`dir/`), never its files.
  assert.ok(
    listed.every((path) => !path.endsWith('/')),
    'PACKED_CLI_CANDIDATE_NESTED_REPOSITORY',
  );
  const deleted = new Set(
    gitPaths((await run('git', ['ls-files', '-z', '--deleted'], options)).stdout),
  );
  const files = [...new Set(listed)].filter((path) => !deleted.has(path)).sort();
  assert.ok(files.length > 0 && files.length <= limits.files, 'PACKED_CLI_CANDIDATE_FILES');
  return files;
}

/**
 * Copy each listed ordinary file byte-for-byte into the empty `destination`. Links (also as a parent
 * directory of a listed path), special files, escaping or noncanonical paths and oversized trees
 * refuse; only the owner's executable bit is kept, as Git records it, as an
 * exact 0755 or 0644 mode under any umask that lets the owner write (one that removes the owner's
 * write bit leaves the created directories unwritable, and the copy refuses before any build).
 * @param {{repository: string, destination: string, files: readonly string[],
 *   limits?: {fileBytes: number, totalBytes: number}}} options `limits` defaults to `CANDIDATE_LIMITS`
 */
export function copyCandidateTree({ repository, destination, files, limits = CANDIDATE_LIMITS }) {
  assert.ok(
    isAbsolute(destination) && readdirSync(destination).length === 0,
    'PACKED_CLI_CANDIDATE_ROOT',
  );
  let total = 0;
  const directories = new Set();
  for (const path of files) {
    assert.ok(
      typeof path === 'string' &&
        path.length > 0 &&
        !path.includes('\\') &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'PACKED_CLI_CANDIDATE_PATH',
    );
    const parts = path.split('/');
    // Every parent below the checkout must be an ordinary directory: Git lists the tracked children
    // of a directory replaced by an (ignored) link, and reading through it would copy outside bytes.
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join('/');
      if (directories.has(parent)) continue;
      assert.ok(
        lstatSync(join(repository, ...parts.slice(0, depth))).isDirectory(),
        'PACKED_CLI_CANDIDATE_PATH',
      );
      directories.add(parent);
    }
    const source = join(repository, ...parts);
    // Git records a file as executable by its owner's execute bit alone.
    const executable = (lstatSync(source).mode & 0o100) !== 0;
    const bytes = readOrdinaryFile(source, limits.fileBytes);
    total += bytes.length;
    assert.ok(total <= limits.totalBytes, 'PACKED_CLI_CANDIDATE_BYTES');
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
 * Temporary files and pnpm's caches go to the private `home`, never into the original checkout; a
 * corepack-managed pnpm runs from the developer's own corepack cache (`COREPACK_HOME`, see
 * `corepackHome` in process.mjs), never from the shared temporary directory.
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
 * Whether every copied file is byte for byte the commit's blob. A clean status does not prove it:
 * line-ending conversion (`core.autocrlf`, the Git for Windows default) and Git's stat cache can report
 * converted working-tree bytes as unchanged, and the candidate is built from those bytes. Each copy's
 * Git blob id (SHA-1 of the blob header and its raw bytes, no filter) must equal the commit tree's
 * entry for its path.
 * @param {{repository: string, candidate: string, source: string, files: readonly string[],
 *   run?: typeof runCommand}} options
 */
export async function copyMatchesCommit({
  repository,
  candidate,
  source,
  files,
  run = runCommand,
}) {
  const listing = (
    await run('git', ['--no-replace-objects', 'ls-tree', '-r', '-z', '--full-tree', source], {
      cwd: repository,
      env: isolatedGitEnvironment(),
    })
  ).stdout;
  const blobs = new Map();
  for (const entry of gitPaths(listing)) {
    const match = /^[0-7]{6} blob ([0-9a-f]{40})\t(.+)$/su.exec(entry);
    if (match !== null) blobs.set(match[2], match[1]);
  }
  return files.every((path) => {
    const bytes = readOrdinaryFile(join(candidate, ...path.split('/')), CANDIDATE_LIMITS.fileBytes);
    const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return blobs.get(path) === id;
  });
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
  const files = await candidateFiles(repository, run, excludes);
  const copied = copyCandidateTree({ repository, destination: candidate, files });
  const after = await sourceIdentity(repository, run, excludes);
  assert.ok(
    after.source === identity.source &&
      after.status === identity.status &&
      isDeepStrictEqual(after.unchecked, identity.unchecked),
    'PACKED_CLI_SOURCE_CHANGED_DURING_COPY',
  );
  // A clean status is confirmed byte for byte: the candidate is built from the copied bytes.
  const dirty =
    identity.dirty ||
    !(await copyMatchesCommit({ repository, candidate, source: identity.source, files, run }));
  const store = await dependencyStore({ repository, environment, home, pnpm });
  await installCandidateDependencies({ candidate, store, env, pnpm });
  verifyCandidateLinks(candidate);
  return { source: identity.source, dirty, files: copied.files };
}
