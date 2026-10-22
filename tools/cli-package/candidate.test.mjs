import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  assertNoBuildCache,
  candidateFiles,
  copyCandidateTree,
  dependencyStore,
  globalExcludesFile,
  installCandidateDependencies,
  prepareCandidate,
  producerEnvironment,
  sourceIdentity,
  verifyCandidateLinks,
} from './candidate.mjs';
import { isolatedEnvironment, isolatedGitEnvironment, runCommand } from './process.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-candidate-tree-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
const posixModes = process.platform !== 'win32';
const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
let count = 0;

function fresh(name) {
  count += 1;
  const path = join(scratch, `${name}-${count}`);
  mkdirSync(path);
  return path;
}

function write(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) chmodSync(path, mode);
}

/** A fake `git` port answering from a table of exact argument lists. */
function git(answers) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const key = args.join(' ');
    assert.ok(Object.hasOwn(answers, key), `unexpected git ${key}`);
    return { stdout: answers[key], stderr: '' };
  };
  return { run, calls };
}

const SHA = 'a'.repeat(40);

test('source identity records the exact commit and the complete porcelain status', async (t) => {
  // A credential in the caller's environment must not reach the isolated Git.
  const previous = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = 'synthetic-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previous;
  });
  const clean = git({
    '--no-replace-objects rev-parse HEAD': `${SHA}\n`,
    'status --porcelain=v1 -z --untracked-files=all': '',
    'ls-files -v -z': 'H a.ts\0H b.ts\0',
  });
  assert.deepEqual(await sourceIdentity('/repository', clean.run), {
    source: SHA,
    status: '',
    unchecked: [],
    dirty: false,
  });
  assert.ok(clean.calls.every((call) => call.command === 'git' && call.cwd === '/repository'));
  // The original checkout is queried with an isolated environment without any home, global or
  // system configuration, never the caller's.
  assert.ok(
    clean.calls.every(
      (call) => isDeepStrictEqual(call.env, isolatedGitEnvironment()) && !('NPM_TOKEN' in call.env),
    ),
  );
  const modified = git({
    '--no-replace-objects rev-parse HEAD': `${SHA}\n`,
    'status --porcelain=v1 -z --untracked-files=all': '?? notes.txt\0',
    'ls-files -v -z': 'H a.ts\0',
  });
  assert.equal((await sourceIdentity('/repository', modified.run)).dirty, true);
  // A file Git is told not to check — skip-worktree (S) or assume-unchanged (a lowercase tag) — is
  // copied unchecked, so it counts as dirty even when the status is empty.
  const unchecked = git({
    '--no-replace-objects rev-parse HEAD': `${SHA}\n`,
    'status --porcelain=v1 -z --untracked-files=all': '',
    'ls-files -v -z': 'H a.ts\0S sparse.ts\0h assumed.ts\0s both.ts\0M merged.ts\0',
  });
  assert.deepEqual(await sourceIdentity('/repository', unchecked.run), {
    source: SHA,
    status: '',
    unchecked: ['sparse.ts', 'assumed.ts', 'both.ts'],
    dirty: true,
  });
  // The developer's global excludes file judges untracked files.
  const excluded = git({
    '--no-replace-objects rev-parse HEAD': `${SHA}\n`,
    '-c core.excludesFile=/home/someone/.config/git/ignore status --porcelain=v1 -z --untracked-files=all':
      '',
    'ls-files -v -z': '',
  });
  assert.equal(
    (await sourceIdentity('/repository', excluded.run, '/home/someone/.config/git/ignore')).dirty,
    false,
  );
  for (const head of ['', 'HEAD\n', `${SHA.slice(1)}\n`, `${SHA}${SHA}\n`]) {
    const malformed = git({
      '--no-replace-objects rev-parse HEAD': head,
      'status --porcelain=v1 -z --untracked-files=all': '',
      'ls-files -v -z': '',
    });
    await assert.rejects(sourceIdentity('/repository', malformed.run), /SOURCE_IDENTITY/u);
  }
});

test('candidate files are tracked plus unignored untracked files, minus deletions, sorted once', async () => {
  const listing = git({
    'ls-files -z --cached --others --exclude-standard': 'b.ts\0a.ts\0gone.ts\0a.ts\0new.ts\0',
    'ls-files -z --deleted': 'gone.ts\0',
  });
  assert.deepEqual(await candidateFiles('/repository', listing.run), ['a.ts', 'b.ts', 'new.ts']);
  assert.ok(listing.calls.every((call) => isDeepStrictEqual(call.env, isolatedGitEnvironment())));
  const empty = git({
    'ls-files -z --cached --others --exclude-standard': '',
    'ls-files -z --deleted': '',
  });
  await assert.rejects(candidateFiles('/repository', empty.run), /CANDIDATE_FILES/u);
  const excluded = git({
    '-c core.excludesFile=/ignore ls-files -z --cached --others --exclude-standard': 'a.ts\0',
    'ls-files -z --deleted': '',
  });
  assert.deepEqual(await candidateFiles('/repository', excluded.run, '/ignore'), ['a.ts']);
});

test("the developer's global excludes file is located without the rest of the global configuration", async () => {
  const home = fresh('developer-home');
  const ignore = join(home, '.config', 'git', 'ignore');
  write(ignore, 'secret.local\n');
  const calls = [];
  const unset = async (command, args, options) => {
    calls.push({ args, env: options.env });
    const error = new Error('PACKED_CLI_CHILD_FAILED: 1');
    error.result = { code: 1, stdout: '', stderr: '' };
    throw error;
  };
  const environment = {
    PATH: '/usr/bin',
    HOME: home,
    NPM_TOKEN: 'synthetic-secret',
    NODE_OPTIONS: '--require=/tmp/preload.cjs',
    GIT_DIR: '/elsewhere',
  };
  assert.equal(
    await globalExcludesFile({ repository: '/repository', environment, run: unset }),
    ignore,
  );
  assert.deepEqual(calls[0].args, ['config', '--path', '--get', 'core.excludesFile']);
  assert.deepEqual(calls[0].env, { PATH: '/usr/bin', HOME: home });
  // Git's default prefers XDG_CONFIG_HOME, and a missing file means no global excludes.
  const xdg = fresh('xdg');
  write(join(xdg, 'git', 'ignore'), '*.local\n');
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { HOME: home, XDG_CONFIG_HOME: xdg },
      run: unset,
    }),
    join(xdg, 'git', 'ignore'),
  );
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { HOME: fresh('empty-home') },
      run: unset,
    }),
    undefined,
  );
  // A configured core.excludesFile wins, resolved against the repository when relative.
  const configured = join(fresh('configured'), 'ignore-file');
  write(configured, '*.secret\n');
  const answer = (stdout) => async () => ({ stdout, stderr: '' });
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { HOME: home },
      run: answer(`${configured}\n`),
    }),
    configured,
  );
  const repository = fresh('relative-repository');
  write(join(repository, 'local-ignore'), '*.secret\n');
  assert.equal(
    await globalExcludesFile({
      repository,
      environment: { HOME: home },
      run: answer('local-ignore\n'),
    }),
    join(repository, 'local-ignore'),
  );
  // A setting present but empty disables Git's global excludes: the default file no longer applies.
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { HOME: home },
      run: answer('\n'),
    }),
    undefined,
  );
  // Any other Git failure refuses, and an explicit file from an isolating caller must exist.
  const broken = async () => {
    const error = new Error('PACKED_CLI_CHILD_FAILED: 128');
    error.result = { code: 128, stdout: '', stderr: '' };
    throw error;
  };
  await assert.rejects(
    globalExcludesFile({ repository: '/repository', environment: { HOME: home }, run: broken }),
    /CHILD_FAILED/u,
  );
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { RELAVIUM_GIT_EXCLUDES_FILE: ignore },
      run: broken,
    }),
    ignore,
  );
  for (const bad of ['relative/ignore', join(home, 'absent-ignore')]) {
    await assert.rejects(
      globalExcludesFile({
        repository: '/repository',
        environment: { RELAVIUM_GIT_EXCLUDES_FILE: bad },
        run: broken,
      }),
      /GIT_EXCLUDES/u,
    );
  }
});

test('a real checkout copies nothing its developer ignores globally', async () => {
  const repository = fresh('real-checkout');
  const env = isolatedEnvironment(repository);
  const inRepository = (args) =>
    runCommand('git', args, { cwd: repository, env, timeoutMs: 30_000 });
  await inRepository(['init', '--quiet']);
  write(join(repository, 'kept.ts'), 'export {};\n');
  write(join(repository, 'secret.local'), 'private\n');
  await inRepository(['add', 'kept.ts']);
  await inRepository([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'one',
  ]);
  const home = fresh('developer-home');
  write(join(home, '.config', 'git', 'ignore'), 'secret.local\n');
  const excludes = await globalExcludesFile({
    repository,
    environment: { PATH: process.env.PATH, HOME: home },
  });
  assert.equal(excludes, join(home, '.config', 'git', 'ignore'));
  assert.deepEqual(await candidateFiles(repository, runCommand, excludes), ['kept.ts']);
  assert.equal((await sourceIdentity(repository, runCommand, excludes)).dirty, false);
  // Without it the isolated Git sees the globally ignored file as untracked.
  assert.deepEqual(await candidateFiles(repository), ['kept.ts', 'secret.local']);
  assert.equal((await sourceIdentity(repository)).dirty, true);
});

test('a real developer configuration with an empty core.excludesFile applies no global excludes', async () => {
  const home = fresh('developer-home');
  write(join(home, '.gitconfig'), '[core]\n\texcludesFile =\n');
  write(join(home, '.config', 'git', 'ignore'), 'secret.local\n');
  assert.equal(
    await globalExcludesFile({
      repository: fresh('repository'),
      environment: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    }),
    undefined,
  );
});

/** A real repository with one committed file, `kept.ts`, created with Git's own configuration off. */
async function committedRepository(name) {
  const repository = fresh(name);
  const inRepository = (args) =>
    runCommand('git', args, { cwd: repository, env: isolatedGitEnvironment(), timeoutMs: 30_000 });
  await inRepository(['init', '--quiet']);
  write(join(repository, 'kept.ts'), 'export {};\n');
  await inRepository(['add', 'kept.ts']);
  await inRepository([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'one',
  ]);
  return { repository, inRepository };
}

test("no configuration found inside the checkout acts as Git's global configuration", async () => {
  const { repository } = await committedRepository('planted-configuration');
  write(join(repository, 'secret.local'), 'private\n');
  // A home-style .gitconfig and an XDG-style git/ignore at the checkout root, untracked, each of
  // which would hide files if Git took the checkout for its home or configuration directory.
  write(join(repository, 'hide'), 'secret.local\n.gitconfig\nhide\ngit/\n');
  write(join(repository, '.gitconfig'), `[core]\n\texcludesFile = ${join(repository, 'hide')}\n`);
  write(join(repository, 'git', 'ignore'), 'secret.local\ngit/\nhide\n.gitconfig\n');
  assert.deepEqual(await candidateFiles(repository), [
    '.gitconfig',
    'git/ignore',
    'hide',
    'kept.ts',
    'secret.local',
  ]);
  assert.equal((await sourceIdentity(repository)).dirty, true);
});

for (const ignoredBy of ['.gitignore', '.git/info/exclude'])
  test(
    `a tracked directory replaced by a link ignored through ${ignoredBy} refuses the copy`,
    { skip: !posixModes },
    async () => {
      const { repository, inRepository } = await committedRepository('linked-parent');
      write(join(repository, 'a', 'b'), 'tracked\n');
      await inRepository(['add', 'a/b']);
      await inRepository([
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'two',
      ]);
      // The directory moves outside the checkout and comes back as a link that Git ignores.
      const outside = join(fresh('outside'), 'a');
      renameSync(join(repository, 'a'), outside);
      write(join(outside, 'b'), 'outside bytes\n');
      symlinkSync(outside, join(repository, 'a'), linkKind);
      write(join(repository, ...ignoredBy.split('/')), 'a\n');
      const files = await candidateFiles(repository);
      assert.ok(files.includes('a/b'));
      assert.throws(
        () => copyCandidateTree({ repository, destination: fresh('copy'), files }),
        /CANDIDATE_PATH/u,
      );
    },
  );

for (const flag of ['--skip-worktree', '--assume-unchanged'])
  test(`a tracked file marked ${flag} makes the identity dirty`, async () => {
    const { repository, inRepository } = await committedRepository('unchecked');
    await inRepository(['update-index', flag, 'kept.ts']);
    write(join(repository, 'kept.ts'), 'export const changed = true;\n');
    // Git's own status cannot see the change, and the copy would take the changed bytes.
    assert.equal((await inRepository(['status', '--porcelain=v1'])).stdout, '');
    assert.deepEqual(await candidateFiles(repository), ['kept.ts']);
    const identity = await sourceIdentity(repository);
    assert.deepEqual(identity.unchecked, ['kept.ts']);
    assert.equal(identity.dirty, true);
  });

test('the candidate copy is byte-exact, keeps only the executable bit and refuses links', () => {
  const repository = fresh('repository');
  write(join(repository, 'package.json'), '{"name":"root"}\n');
  write(join(repository, 'tools', 'run.mjs'), '#!/usr/bin/env node\n', 0o775);
  write(join(repository, 'docs', 'note.md'), 'note\n', 0o640);
  const destination = fresh('copy');
  const files = ['docs/note.md', 'package.json', 'tools/run.mjs'];
  assert.deepEqual(copyCandidateTree({ repository, destination, files }), { files: 3, bytes: 41 });
  for (const path of files) {
    assert.ok(readFileSync(join(destination, path)).equals(readFileSync(join(repository, path))));
  }
  if (posixModes) {
    assert.equal(statSync(join(destination, 'tools', 'run.mjs')).mode & 0o777, 0o755);
    assert.equal(statSync(join(destination, 'docs', 'note.md')).mode & 0o777, 0o644);
  }
  if (posixModes) {
    // The modes are exact whatever the process umask.
    const previous = process.umask(0o077);
    let restrictive;
    try {
      restrictive = fresh('copy');
      copyCandidateTree({ repository, destination: restrictive, files });
    } finally {
      process.umask(previous);
    }
    assert.equal(statSync(join(restrictive, 'tools', 'run.mjs')).mode & 0o777, 0o755);
    assert.equal(statSync(join(restrictive, 'docs', 'note.md')).mode & 0o777, 0o644);
  }
  assert.throws(
    () => copyCandidateTree({ repository, destination, files }),
    /CANDIDATE_ROOT/u,
    'a non-empty destination refuses',
  );
  for (const path of ['../escape.ts', 'a/../b.ts', './a.ts', 'a//b.ts', 'a\\b.ts', '']) {
    assert.throws(
      () => copyCandidateTree({ repository, destination: fresh('copy'), files: [path] }),
      /CANDIDATE_PATH/u,
    );
  }
  if (posixModes) {
    // A link as a parent directory refuses too, not only as the file itself.
    const elsewhere = fresh('elsewhere');
    write(join(elsewhere, 'inner.ts'), 'outside\n');
    symlinkSync(elsewhere, join(repository, 'linked-directory'), linkKind);
    assert.throws(
      () =>
        copyCandidateTree({
          repository,
          destination: fresh('copy'),
          files: ['linked-directory/inner.ts'],
        }),
      /CANDIDATE_PATH/u,
    );
    symlinkSync(join(repository, 'package.json'), join(repository, 'linked.json'));
    assert.throws(
      () => copyCandidateTree({ repository, destination: fresh('copy'), files: ['linked.json'] }),
      /FILE_KIND_OR_BOUND/u,
    );
  }
});

test('the dependency store is discovered with store-location variables only', async () => {
  const store = fresh('store');
  const calls = [];
  const pnpm = async (args, options) => {
    calls.push({ args, options });
    return { stdout: `${store}\n`, stderr: '' };
  };
  const environment = {
    HOME: '/home/someone',
    XDG_DATA_HOME: '/home/someone/.local/share',
    NPM_TOKEN: 'synthetic-secret',
    NODE_OPTIONS: '--require=/tmp/preload.cjs',
    npm_config_registry: 'https://registry.invalid/',
  };
  const home = fresh('private-home');
  assert.equal(
    await dependencyStore({ repository: '/repository', environment, home, pnpm }),
    store,
  );
  assert.deepEqual(calls[0].args, ['store', 'path']);
  const env = calls[0].options.env;
  assert.equal(env.HOME, '/home/someone');
  assert.equal(env.XDG_DATA_HOME, '/home/someone/.local/share');
  // Temporary files and caches (Node's compile cache, corepack) never land in the checkout.
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME']) assert.equal(env[key], home, key);
  for (const key of [
    'NPM_TOKEN',
    'NODE_OPTIONS',
    'npm_config_registry',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
  ]) {
    assert.equal(key in env, false, key);
  }
  // A caller that already isolated this process names the store explicitly; pnpm is not asked.
  const explicit = fresh('explicit-store');
  assert.equal(
    await dependencyStore({
      repository: '/repository',
      environment: { RELAVIUM_PACKAGE_STORE_DIR: explicit },
      home,
      pnpm: async () => {
        throw new Error('store discovery must not run');
      },
    }),
    explicit,
  );
  for (const bad of ['relative/store', join(scratch, 'absent-store')]) {
    await assert.rejects(
      dependencyStore({
        repository: '/repository',
        environment: { RELAVIUM_PACKAGE_STORE_DIR: bad },
        home,
        pnpm,
      }),
      /DEPENDENCY_STORE/u,
    );
  }
  for (const answer of ['relative/store\n', `${join(scratch, 'absent-store')}\n`]) {
    await assert.rejects(
      dependencyStore({
        repository: '/repository',
        environment,
        home,
        pnpm: async () => ({ stdout: answer, stderr: '' }),
      }),
      /DEPENDENCY_STORE/u,
    );
  }
});

test('store discovery refuses a private home inside the original checkout', async () => {
  const repository = fresh('checkout');
  // A child whose name merely starts with two dots is inside the checkout too.
  for (const home of [join(repository, 'home'), join(repository, '..home')]) {
    await assert.rejects(
      dependencyStore({
        repository,
        environment: { HOME: '/home/someone' },
        home,
        pnpm: async () => {
          throw new Error('store discovery must not run');
        },
      }),
      /PRIVATE_HOME/u,
      home,
    );
  }
});

test('the candidate installs offline, frozen and without lifecycle scripts', async () => {
  const calls = [];
  await installCandidateDependencies({
    candidate: '/candidate',
    store: '/store',
    env: { HOME: '/home' },
    pnpm: async (args, options) => {
      calls.push({ args, options });
      return { stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls, [
    {
      args: [
        'install',
        '--offline',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--store-dir',
        '/store',
      ],
      options: { cwd: '/candidate', env: { HOME: '/home' } },
    },
  ]);
});

function linkedCandidate() {
  const root = fresh('candidate');
  mkdirSync(join(root, 'node_modules'));
  for (const name of ['shared', 'llm', 'core', 'db', 'mcp']) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
  }
  const scope = join(root, 'apps', 'cli', 'node_modules', '@relavium');
  mkdirSync(scope, { recursive: true });
  for (const name of ['shared', 'llm', 'core', 'db', 'mcp']) {
    symlinkSync(join(root, 'packages', name), join(scope, name), linkKind);
  }
  return root;
}

test('every workspace link must resolve inside the candidate', () => {
  const root = linkedCandidate();
  verifyCandidateLinks(root);
  const original = fresh('original-checkout');
  mkdirSync(join(original, 'core'));
  const link = join(root, 'apps', 'cli', 'node_modules', '@relavium', 'core');
  rmSync(link);
  symlinkSync(join(original, 'core'), link, linkKind);
  assert.throws(() => verifyCandidateLinks(root), /CANDIDATE_LINK/u);

  const nested = linkedCandidate();
  const coreScope = join(nested, 'packages', 'core', 'node_modules', '@relavium');
  mkdirSync(coreScope, { recursive: true });
  symlinkSync(join(original, 'core'), join(coreScope, 'shared'), linkKind);
  assert.throws(() => verifyCandidateLinks(nested), /CANDIDATE_LINK/u);

  const missing = linkedCandidate();
  rmSync(join(missing, 'apps', 'cli', 'node_modules', '@relavium', 'mcp'));
  assert.throws(() => verifyCandidateLinks(missing), /CANDIDATE_LINK/u);

  // The root node_modules must not resolve into the original checkout either.
  const borrowed = linkedCandidate();
  rmSync(join(borrowed, 'node_modules'), { recursive: true });
  mkdirSync(join(original, 'node_modules'));
  symlinkSync(join(original, 'node_modules'), join(borrowed, 'node_modules'), linkKind);
  assert.throws(() => verifyCandidateLinks(borrowed), /CANDIDATE_LINK/u);
});

test('a candidate build leaves no build cache behind', () => {
  const root = fresh('built');
  write(join(root, 'packages', 'core', 'dist', 'index.js'), 'export {};\n');
  write(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  assertNoBuildCache(root);
  for (const marker of [
    'packages/core/tsconfig.build.tsbuildinfo',
    '.turbo/cache/abc.tar.zst',
    'apps/cli/.turbo/turbo-build.log',
    'node_modules/.cache/tool/state',
    'apps/cli/node_modules/.cache/state',
  ]) {
    const candidate = fresh('built');
    write(join(candidate, 'packages', 'core', 'dist', 'index.js'), 'export {};\n');
    write(join(candidate, marker), 'cache\n');
    assert.throws(() => assertNoBuildCache(candidate), /CANDIDATE_BUILD_CACHE/u, marker);
  }
  assert.deepEqual(readdirSync(root).sort(), ['node_modules', 'packages']);
});

/** A source repository plus fake git and pnpm ports; the fake install creates the workspace links. */
function preparation({
  status = '',
  statusAfterCopy = status,
  headAfterCopy = SHA,
  unchecked = '',
  uncheckedAfterCopy = unchecked,
  excludes,
  misLink,
} = {}) {
  const repository = fresh('source');
  write(join(repository, 'package.json'), '{}\n');
  for (const name of ['shared', 'llm', 'core', 'db', 'mcp']) {
    write(join(repository, 'packages', name, 'package.json'), '{}\n');
  }
  const files = [
    'package.json',
    ...['shared', 'llm', 'core', 'db', 'mcp'].map((name) => `packages/${name}/package.json`),
  ];
  const candidate = fresh('candidate');
  const store = fresh('store');
  const home = fresh('home');
  const events = [];
  let statuses = 0;
  let heads = 0;
  let flags = 0;
  // With an excludes file, the listing and both status calls answer only when they carry it.
  const prefix = excludes === undefined ? '' : `-c core.excludesFile=${excludes} `;
  const run = async (command, args) => {
    const key = args.join(' ');
    events.push(`git ${key}`);
    if (key === '--no-replace-objects rev-parse HEAD') {
      heads += 1;
      return { stdout: `${heads === 1 ? SHA : headAfterCopy}\n` };
    }
    if (key === `${prefix}status --porcelain=v1 -z --untracked-files=all`) {
      statuses += 1;
      return { stdout: statuses === 1 ? status : statusAfterCopy };
    }
    if (key === `${prefix}ls-files -z --cached --others --exclude-standard`)
      return { stdout: files.join('\0') };
    if (key === 'ls-files -z --deleted') return { stdout: '' };
    if (key === 'ls-files -v -z') {
      flags += 1;
      return { stdout: `H package.json\0${flags === 1 ? unchecked : uncheckedAfterCopy}` };
    }
    throw new Error(`unexpected git ${key}`);
  };
  const pnpm = async (args, options) => {
    events.push(`pnpm ${args.join(' ')}`);
    if (args[0] === 'store') return { stdout: `${store}\n` };
    assert.equal(options.cwd, candidate);
    // `misLink` makes the install resolve one engine package, or the root dependency directory, to
    // the original checkout instead of the candidate.
    if (misLink === 'root')
      symlinkSync(fresh('borrowed-modules'), join(candidate, 'node_modules'), linkKind);
    else mkdirSync(join(candidate, 'node_modules'), { recursive: true });
    const scope = join(candidate, 'apps', 'cli', 'node_modules', '@relavium');
    mkdirSync(scope, { recursive: true });
    for (const name of ['shared', 'llm', 'core', 'db', 'mcp']) {
      const owner = misLink === 'engine' && name === 'core' ? repository : candidate;
      symlinkSync(join(owner, 'packages', name), join(scope, name), linkKind);
    }
    return { stdout: '' };
  };
  return { repository, candidate, store, home, events, run, pnpm };
}

test('candidate preparation copies, re-checks identity, installs and verifies links in order', async () => {
  const ports = preparation();
  const identity = await prepareCandidate({
    repository: ports.repository,
    candidate: ports.candidate,
    environment: { HOME: '/home/someone' },
    home: ports.home,
    env: { HOME: '/isolated' },
    run: ports.run,
    pnpm: ports.pnpm,
  });
  assert.deepEqual(identity, { source: SHA, dirty: false, files: 6 });
  assert.deepEqual(ports.events, [
    'git --no-replace-objects rev-parse HEAD',
    'git status --porcelain=v1 -z --untracked-files=all',
    'git ls-files -v -z',
    'git ls-files -z --cached --others --exclude-standard',
    'git ls-files -z --deleted',
    'git --no-replace-objects rev-parse HEAD',
    'git status --porcelain=v1 -z --untracked-files=all',
    'git ls-files -v -z',
    'pnpm store path',
    `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir ${ports.store}`,
  ]);
  assert.ok(
    readFileSync(join(ports.candidate, 'package.json')).equals(
      readFileSync(join(ports.repository, 'package.json')),
    ),
  );
});

test('a modified or unchecked source makes the prepared identity dirty', async () => {
  for (const source of [
    { status: ' M package.json\0' },
    { unchecked: 'S packages/core/package.json\0' },
  ]) {
    const ports = preparation(source);
    const identity = await prepareCandidate({
      repository: ports.repository,
      candidate: ports.candidate,
      environment: {},
      home: ports.home,
      env: {},
      run: ports.run,
      pnpm: ports.pnpm,
    });
    assert.deepEqual(identity, { source: SHA, dirty: true, files: 6 });
  }
});

test('an installed link outside the candidate refuses after the install', async () => {
  for (const misLink of ['engine', 'root']) {
    const ports = preparation({ misLink });
    await assert.rejects(
      prepareCandidate({
        repository: ports.repository,
        candidate: ports.candidate,
        environment: {},
        home: ports.home,
        env: {},
        run: ports.run,
        pnpm: ports.pnpm,
      }),
      /CANDIDATE_LINK/u,
    );
    assert.match(ports.events.at(-1), /^pnpm install /u);
  }
});

test('a source change during the copy refuses before anything is installed', async () => {
  // A changed status, a commit that moved while the status stayed the same, or a file Git was told
  // not to check during the copy.
  for (const change of [
    { statusAfterCopy: ' M package.json\0' },
    { headAfterCopy: 'b'.repeat(40) },
    { uncheckedAfterCopy: 'h tools/run.mjs\0' },
  ]) {
    const ports = preparation(change);
    await assert.rejects(
      prepareCandidate({
        repository: ports.repository,
        candidate: ports.candidate,
        environment: {},
        home: ports.home,
        env: {},
        run: ports.run,
        pnpm: ports.pnpm,
      }),
      /SOURCE_CHANGED_DURING_COPY/u,
    );
    assert.equal(
      ports.events.some((event) => event.startsWith('pnpm')),
      false,
    );
  }
});

test("candidate preparation applies the developer's global excludes to every listing and status", async () => {
  const ports = preparation({ excludes: '/developer/ignore' });
  const identity = await prepareCandidate({
    repository: ports.repository,
    candidate: ports.candidate,
    environment: {},
    home: ports.home,
    env: {},
    excludes: '/developer/ignore',
    run: ports.run,
    pnpm: ports.pnpm,
  });
  assert.deepEqual(identity, { source: SHA, dirty: false, files: 6 });
  assert.deepEqual(
    ports.events.filter((event) => event.includes('status') || event.includes('--cached')),
    [
      'git -c core.excludesFile=/developer/ignore status --porcelain=v1 -z --untracked-files=all',
      'git -c core.excludesFile=/developer/ignore ls-files -z --cached --others --exclude-standard',
      'git -c core.excludesFile=/developer/ignore status --porcelain=v1 -z --untracked-files=all',
    ],
  );
});

test('an isolated producer receives the store and, when found, the excludes file', () => {
  assert.deepEqual(producerEnvironment({ HOME: '/isolated' }, { store: '/store' }), {
    HOME: '/isolated',
    RELAVIUM_PACKAGE_STORE_DIR: '/store',
  });
  assert.deepEqual(
    producerEnvironment({ HOME: '/isolated' }, { store: '/store', excludes: '/developer/ignore' }),
    {
      HOME: '/isolated',
      RELAVIUM_PACKAGE_STORE_DIR: '/store',
      RELAVIUM_GIT_EXCLUDES_FILE: '/developer/ignore',
    },
  );
});

test('the candidate refuses a file list or a tree over its bounds', async () => {
  const listing = git({
    'ls-files -z --cached --others --exclude-standard': 'a.ts\0b.ts\0c.ts\0',
    'ls-files -z --deleted': '',
  });
  assert.deepEqual(await candidateFiles('/repository', listing.run, undefined, { files: 3 }), [
    'a.ts',
    'b.ts',
    'c.ts',
  ]);
  await assert.rejects(
    candidateFiles('/repository', listing.run, undefined, { files: 2 }),
    /CANDIDATE_FILES/u,
  );
  const repository = fresh('bounded');
  write(join(repository, 'a.ts'), 'abcdef');
  write(join(repository, 'b.ts'), 'ghijkl');
  const files = ['a.ts', 'b.ts'];
  assert.deepEqual(
    copyCandidateTree({
      repository,
      destination: fresh('copy'),
      files,
      limits: { fileBytes: 6, totalBytes: 12 },
    }),
    { files: 2, bytes: 12 },
  );
  assert.throws(
    () =>
      copyCandidateTree({
        repository,
        destination: fresh('copy'),
        files,
        limits: { fileBytes: 6, totalBytes: 11 },
      }),
    /CANDIDATE_BYTES/u,
  );
  assert.throws(
    () =>
      copyCandidateTree({
        repository,
        destination: fresh('copy'),
        files,
        limits: { fileBytes: 5, totalBytes: 12 },
      }),
    /FILE_KIND_OR_BOUND/u,
  );
});
