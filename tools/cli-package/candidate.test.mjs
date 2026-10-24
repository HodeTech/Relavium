import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
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
import { dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import {
  assertNoBuildCache,
  candidateFiles,
  copyCandidateTree,
  copyMatchesCommit,
  dependencyStore,
  globalExcludesFile,
  installCandidateDependencies,
  prepareCandidate,
  producerEnvironment,
  sourceIdentity,
  verifyCandidateLinks,
  CANDIDATE_LIMITS,
} from './candidate.mjs';
import { isolatedGitEnvironment, runCommand } from './process.mjs';

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
/** The explicit attributes and excludes arguments of a checkout-reading status or listing. */
const READ = (excludes = '/dev/null') =>
  `-c core.attributesFile=/dev/null -c core.excludesFile=${excludes} `;

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
    [`${READ()}status --porcelain=v1 -z --untracked-files=all`]: '',
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
    [`${READ()}status --porcelain=v1 -z --untracked-files=all`]: '?? notes.txt\0',
    'ls-files -v -z': 'H a.ts\0',
  });
  assert.equal((await sourceIdentity('/repository', modified.run)).dirty, true);
  // A file Git is told not to check — skip-worktree (S) or assume-unchanged (a lowercase tag) — is
  // copied unchecked, so it counts as dirty even when the status is empty.
  const unchecked = git({
    '--no-replace-objects rev-parse HEAD': `${SHA}\n`,
    [`${READ()}status --porcelain=v1 -z --untracked-files=all`]: '',
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
    [`${READ('/home/someone/.config/git/ignore')}status --porcelain=v1 -z --untracked-files=all`]:
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
      [`${READ()}status --porcelain=v1 -z --untracked-files=all`]: '',
      'ls-files -v -z': '',
    });
    await assert.rejects(sourceIdentity('/repository', malformed.run), /SOURCE_IDENTITY/u);
  }
});

test('candidate files are tracked plus unignored untracked files, minus deletions, sorted once', async () => {
  const listing = git({
    [`${READ()}ls-files -z --cached --others --exclude-standard`]:
      'b.ts\0a.ts\0gone.ts\0a.ts\0new.ts\0',
    'ls-files -z --deleted': 'gone.ts\0',
  });
  assert.deepEqual(await candidateFiles('/repository', listing.run), ['a.ts', 'b.ts', 'new.ts']);
  assert.ok(listing.calls.every((call) => isDeepStrictEqual(call.env, isolatedGitEnvironment())));
  const empty = git({
    [`${READ()}ls-files -z --cached --others --exclude-standard`]: '',
    'ls-files -z --deleted': '',
  });
  await assert.rejects(candidateFiles('/repository', empty.run), /CANDIDATE_FILES/u);
  const excluded = git({
    [`${READ('/ignore')}ls-files -z --cached --others --exclude-standard`]: 'a.ts\0',
    'ls-files -z --deleted': '',
  });
  assert.deepEqual(await candidateFiles('/repository', excluded.run, '/ignore'), ['a.ts']);
  // An untracked nested repository is listed only as its directory and refuses by name.
  const nested = git({
    [`${READ()}ls-files -z --cached --others --exclude-standard`]: 'a.ts\0vendor/clone/\0',
    'ls-files -z --deleted': '',
  });
  await assert.rejects(
    candidateFiles('/repository', nested.run),
    /PACKED_CLI_CANDIDATE_NESTED_REPOSITORY/u,
  );
});

test("the developer's global excludes file is located without the rest of the global configuration", async () => {
  const home = fresh('developer-home');
  const ignore = join(home, '.config', 'git', 'ignore');
  write(ignore, 'secret.local\n');
  const calls = [];
  const unset = async (command, args, options) => {
    calls.push({ args, env: options.env, cwd: options.cwd });
    const error = new Error('PACKED_CLI_CHILD_FAILED: 1');
    error.result = { code: 1, stdout: '', stderr: '' };
    throw error;
  };
  // Every variable Git uses to locate its configuration is forwarded, and nothing else.
  const locations = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'xdg-absent'),
    GIT_CONFIG_GLOBAL: join(home, 'global-config'),
    GIT_CONFIG_SYSTEM: join(home, 'system-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    // Command-scope configuration the developer's Git takes from the environment.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: '/env/ignore',
    GIT_CONFIG_PARAMETERS: "'core.quotepath'='false'",
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
  };
  const environment = {
    PATH: '/usr/bin',
    ...locations,
    NPM_TOKEN: 'synthetic-secret',
    NODE_OPTIONS: '--require=/tmp/preload.cjs',
    GIT_DIR: '/elsewhere',
    GIT_CONFIG_KEY_X: 'not an entry',
  };
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { ...environment, XDG_CONFIG_HOME: '' },
      run: unset,
    }),
    ignore,
  );
  assert.deepEqual(calls[0].args, ['config', '--path', '--get', 'core.excludesFile']);
  // It reads the checkout's own configuration as the developer's Git there would.
  assert.equal(calls[0].cwd, '/repository');
  assert.deepEqual(calls[0].env, { PATH: '/usr/bin', ...locations, XDG_CONFIG_HOME: '' });
  await globalExcludesFile({ repository: '/repository', environment, run: unset });
  assert.deepEqual(calls[1].env, { PATH: '/usr/bin', ...locations });
  // With no PATH the lookup gets no PATH either, never an empty one that names the checkout.
  await globalExcludesFile({ repository: '/repository', environment: { HOME: home }, run: unset });
  assert.equal('PATH' in calls.at(-1).env, false);
  // Without HOME, Git's default uses USERPROFILE; with both, HOME wins.
  const profile = fresh('profile');
  write(join(profile, '.config', 'git', 'ignore'), '*.profile\n');
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { USERPROFILE: profile },
      run: unset,
    }),
    join(profile, '.config', 'git', 'ignore'),
  );
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { HOME: home, USERPROFILE: profile },
      run: unset,
    }),
    ignore,
  );
  // An empty HOME names no default, not one relative to this process's working directory.
  const cwd = process.cwd();
  const relativeDefault = fresh('relative-default');
  write(join(relativeDefault, '.config', 'git', 'ignore'), '*.relative\n');
  process.chdir(relativeDefault);
  try {
    assert.equal(
      await globalExcludesFile({
        repository: '/repository',
        environment: { HOME: '' },
        run: unset,
      }),
      undefined,
    );
  } finally {
    process.chdir(cwd);
  }
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
  // A configured path that is a directory names no excludes file.
  assert.equal(
    await globalExcludesFile({
      repository: '/repository',
      environment: { HOME: home },
      run: answer(`${fresh('directory-excludes')}\n`),
    }),
    undefined,
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
  // A relative explicit file refuses even when it exists from this process's working directory.
  for (const bad of ['relative/ignore', 'package.json', join(home, 'absent-ignore')]) {
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
  // The fixture and the lookup both run without the host's system configuration.
  const inRepository = (args) =>
    runCommand('git', args, { cwd: repository, env: isolatedGitEnvironment(), timeoutMs: 30_000 });
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
    environment: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
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

for (const [label, place] of [
  [
    'an XDG configuration directory',
    (root, ignore) => {
      write(join(root, 'xdg', 'git', 'config'), `[core]\n\texcludesFile = ${ignore}\n`);
      return { XDG_CONFIG_HOME: join(root, 'xdg') };
    },
  ],
  [
    'a GIT_CONFIG_GLOBAL file',
    (root, ignore) => {
      write(join(root, 'dotfiles', 'gitconfig'), `[core]\n\texcludesFile = ${ignore}\n`);
      return { GIT_CONFIG_GLOBAL: join(root, 'dotfiles', 'gitconfig') };
    },
  ],
])
  test(`a real core.excludesFile set only in ${label} is found`, async () => {
    const root = fresh('developer');
    const ignore = join(root, 'my-ignore');
    write(ignore, 'secret.local\n');
    mkdirSync(join(root, 'empty-home'));
    assert.equal(
      await globalExcludesFile({
        repository: fresh('repository'),
        environment: {
          PATH: process.env.PATH,
          HOME: join(root, 'empty-home'),
          GIT_CONFIG_NOSYSTEM: '1',
          ...place(root, ignore),
        },
      }),
      ignore,
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

const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

for (const ignoredBy of ['.gitignore', '.git/info/exclude'])
  for (const linked of ['a', 'a/b'])
    test(
      `a tracked directory ${linked} replaced by a link ignored through ${ignoredBy} refuses the copy`,
      { skip: !posixModes },
      async () => {
        const { repository, inRepository } = await committedRepository('linked-parent');
        write(join(repository, 'a', 'b', 'c'), 'tracked\n');
        await inRepository(['add', 'a/b/c']);
        await inRepository([...COMMIT, 'commit', '--quiet', '-m', 'two']);
        // The directory moves outside the checkout and comes back as a link that Git ignores; a link
        // above the listed file's own directory must refuse as well as its direct parent.
        const outside = join(fresh('outside'), 'moved');
        renameSync(join(repository, ...linked.split('/')), outside);
        write(join(outside, ...'a/b/c'.slice(linked.length + 1).split('/')), 'outside bytes\n');
        symlinkSync(outside, join(repository, ...linked.split('/')), linkKind);
        write(join(repository, ...ignoredBy.split('/')), `/${linked}\n`);
        const files = await candidateFiles(repository);
        assert.ok(files.includes('a/b/c'));
        const destination = fresh('copy');
        assert.throws(
          () => copyCandidateTree({ repository, destination, files }),
          /CANDIDATE_PATH/u,
        );
        assert.equal(existsSync(join(destination, 'a', 'b', 'c')), false);
      },
    );

test('a replace ref on HEAD cannot hide a substituted tree from the identity', async () => {
  const { repository, inRepository } = await committedRepository('replaced');
  const reviewed = (await inRepository(['rev-parse', 'HEAD'])).stdout.trim();
  // An unrelated commit with other bytes, then a replace ref that substitutes it for HEAD and an
  // index and working tree that match it, as `git reset --hard` under that ref would leave them.
  write(join(repository, 'kept.ts'), 'export const substituted = true;\n');
  await inRepository(['add', 'kept.ts']);
  const tree = (await inRepository(['write-tree'])).stdout.trim();
  const other = (await inRepository([...COMMIT, 'commit-tree', tree, '-m', 'other'])).stdout.trim();
  await inRepository(['replace', reviewed, other]);
  await inRepository(['read-tree', '--reset', '-u', other]);
  // Git honouring the replace ref sees a clean tree; the identity must not.
  const honouring = Object.fromEntries(
    Object.entries(isolatedGitEnvironment()).filter(([key]) => key !== 'GIT_NO_REPLACE_OBJECTS'),
  );
  const status = await runCommand('git', ['status', '--porcelain=v1'], {
    cwd: repository,
    env: honouring,
  });
  assert.equal(status.stdout, '');
  const identity = await sourceIdentity(repository);
  assert.equal(identity.source, reviewed);
  assert.match(identity.status, /kept\.ts/u);
  assert.equal(identity.dirty, true);
});

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
  // Group and other execute bits alone do not make a file executable, as in Git's index.
  write(join(repository, 'docs', 'group.sh'), 'x\n', 0o654);
  const destination = fresh('copy');
  const files = ['docs/group.sh', 'docs/note.md', 'package.json', 'tools/run.mjs'];
  assert.deepEqual(copyCandidateTree({ repository, destination, files }), { files: 4, bytes: 43 });
  for (const path of files) {
    assert.ok(readFileSync(join(destination, path)).equals(readFileSync(join(repository, path))));
  }
  if (posixModes) {
    assert.equal(statSync(join(destination, 'tools', 'run.mjs')).mode & 0o777, 0o755);
    assert.equal(statSync(join(destination, 'docs', 'note.md')).mode & 0o777, 0o644);
    assert.equal(statSync(join(destination, 'docs', 'group.sh')).mode & 0o777, 0o644);
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
    write(join(elsewhere, 'sub', 'inner.ts'), 'outside\n');
    symlinkSync(elsewhere, join(repository, 'linked-directory'), linkKind);
    mkdirSync(join(repository, 'real'));
    symlinkSync(elsewhere, join(repository, 'real', 'linked'), linkKind);
    // The link may be the file's direct parent, a directory above it or a directory below the root.
    for (const path of [
      'linked-directory/inner.ts',
      'linked-directory/sub/inner.ts',
      'real/linked/inner.ts',
    ]) {
      assert.throws(
        () => copyCandidateTree({ repository, destination: fresh('copy'), files: [path] }),
        /CANDIDATE_PATH/u,
        path,
      );
    }
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
  // Every store-location variable reaches the discovery, which runs in the original checkout.
  const locations = {
    HOME: '/l/home',
    USERPROFILE: '/l/profile',
    XDG_DATA_HOME: '/l/data',
    XDG_CONFIG_HOME: '/l/config',
    LOCALAPPDATA: '/l/local',
    APPDATA: '/l/appdata',
    PNPM_HOME: '/l/pnpm',
    npm_config_store_dir: '/l/store-lower',
    NPM_CONFIG_STORE_DIR: '/l/store-upper',
  };
  await dependencyStore({
    repository: '/repository',
    environment: { ...locations, NPM_TOKEN: 'synthetic-secret' },
    home,
    pnpm,
  });
  assert.equal(calls[1].options.cwd, '/repository');
  for (const [key, value] of Object.entries(locations))
    assert.equal(calls[1].options.env[key], value, key);
  assert.equal('NPM_TOKEN' in calls[1].options.env, false);
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
  // A relative store refuses even when it exists from this process's working directory.
  for (const bad of ['relative/store', 'tools', join(scratch, 'absent-store')]) {
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
  for (const answer of ['relative/store\n', 'tools\n', `${join(scratch, 'absent-store')}\n`]) {
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
  for (const home of [join(repository, 'home'), join(repository, '..home'), 'relative-home']) {
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
/** Git's blob object id for raw bytes. */
const blobId = (bytes) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function preparation({
  status = '',
  statusAfterCopy = status,
  headAfterCopy = SHA,
  unchecked = '',
  uncheckedAfterCopy = unchecked,
  excludes,
  misLink,
  convertedPath,
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
  const prefix = READ(excludes);
  const run = async (command, args, options) => {
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
    // The commit's tree: each file's blob id, except `convertedPath`, whose committed blob differs
    // from the working-tree bytes (as line-ending conversion leaves it while status stays clean).
    if (key === `--no-replace-objects ls-tree -r -z --full-tree ${SHA}`) {
      // Asked of the original checkout, through Git without home, global or system configuration.
      assert.equal(options.cwd, repository);
      assert.deepEqual(options.env, isolatedGitEnvironment());
      return {
        stdout: files
          .map((path) => {
            const bytes = readFileSync(join(repository, ...path.split('/')));
            const committed = path === convertedPath ? Buffer.from('{}\r\n') : bytes;
            return `100644 blob ${blobId(committed)}\t${path}`;
          })
          .join('\0'),
      };
    }
    throw new Error(`unexpected git ${key}`);
  };
  let installOptions;
  const pnpm = async (args, options) => {
    events.push(`pnpm ${args.join(' ')}`);
    if (args[0] === 'store') return { stdout: `${store}\n` };
    assert.equal(options.cwd, candidate);
    installOptions = options;
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
  return {
    repository,
    candidate,
    store,
    home,
    events,
    run,
    pnpm,
    installOptions: () => installOptions,
  };
}

test('candidate preparation copies, re-checks identity, installs and verifies links in order', async () => {
  const ports = preparation();
  const env = { HOME: '/isolated' };
  const identity = await prepareCandidate({
    repository: ports.repository,
    candidate: ports.candidate,
    environment: {
      HOME: '/home/someone',
      NPM_TOKEN: 'synthetic-secret',
      NODE_OPTIONS: '--require=/x.cjs',
    },
    home: ports.home,
    env,
    run: ports.run,
    pnpm: ports.pnpm,
  });
  // The install runs in the isolated environment it was given, never the caller's own.
  assert.equal(ports.installOptions().env, env);
  assert.deepEqual(identity, { source: SHA, dirty: false, files: 6 });
  assert.deepEqual(ports.events, [
    'git --no-replace-objects rev-parse HEAD',
    `git ${READ()}status --porcelain=v1 -z --untracked-files=all`,
    'git ls-files -v -z',
    `git ${READ()}ls-files -z --cached --others --exclude-standard`,
    'git ls-files -z --deleted',
    'git --no-replace-objects rev-parse HEAD',
    `git ${READ()}status --porcelain=v1 -z --untracked-files=all`,
    'git ls-files -v -z',
    `git --no-replace-objects ls-tree -r -z --full-tree ${SHA}`,
    'pnpm store path',
    `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir ${ports.store}`,
  ]);
  assert.ok(
    readFileSync(join(ports.candidate, 'package.json')).equals(
      readFileSync(join(ports.repository, 'package.json')),
    ),
  );
});

test('a copy that differs from the commit is dirty even when status reports the tree clean', async () => {
  // Whichever copied file differs.
  for (const convertedPath of [
    'package.json',
    ...['shared', 'llm', 'core', 'db', 'mcp'].map((name) => `packages/${name}/package.json`),
  ]) {
    const ports = preparation({ convertedPath });
    const identity = await prepareCandidate({
      repository: ports.repository,
      candidate: ports.candidate,
      environment: {},
      home: ports.home,
      env: {},
      run: ports.run,
      pnpm: ports.pnpm,
    });
    assert.deepEqual(identity, { source: SHA, dirty: true, files: 6 }, convertedPath);
  }
  // An identity that status already calls dirty is not checked again.
  const dirty = preparation({ status: ' M package.json\0', statusAfterCopy: ' M package.json\0' });
  await prepareCandidate({
    repository: dirty.repository,
    candidate: dirty.candidate,
    environment: {},
    home: dirty.home,
    env: {},
    run: dirty.run,
    pnpm: dirty.pnpm,
  });
  assert.equal(
    dirty.events.some((event) => event.includes('ls-tree')),
    false,
  );
});

test('a checkout whose line endings Git converts copies bytes that are not the commit', async () => {
  const { repository, inRepository } = await committedRepository('converted-line-endings');
  // core.autocrlf in the checkout's own configuration, which Git reading the checkout honours:
  // the file is checked out with CRLF while its blob keeps LF, and status stays clean.
  await inRepository(['config', 'core.autocrlf', 'true']);
  rmSync(join(repository, 'kept.ts'));
  await inRepository(['checkout', '--', 'kept.ts']);
  assert.equal(readFileSync(join(repository, 'kept.ts'), 'utf8'), 'export {};\r\n');
  const identity = await sourceIdentity(repository);
  assert.equal(identity.dirty, false);
  const candidate = fresh('converted-copy');
  copyCandidateTree({ repository, destination: candidate, files: ['kept.ts'] });
  assert.equal(
    await copyMatchesCommit({ repository, candidate, source: identity.source, files: ['kept.ts'] }),
    false,
  );
  // The committed bytes match; a file the commit does not hold does not.
  writeFileSync(join(candidate, 'kept.ts'), 'export {};\n');
  assert.equal(
    await copyMatchesCommit({ repository, candidate, source: identity.source, files: ['kept.ts'] }),
    true,
  );
  write(join(candidate, 'extra.ts'), 'export {};\n');
  assert.equal(
    await copyMatchesCommit({
      repository,
      candidate,
      source: identity.source,
      files: ['kept.ts', 'extra.ts'],
    }),
    false,
  );
});

test('a store the caller names reaches the install, and pnpm is never asked to discover one', async () => {
  const ports = preparation();
  const explicit = fresh('explicit-store');
  const pnpm = async (args, options) => {
    if (args[0] === 'store') throw new Error('store discovery must not run');
    return ports.pnpm(args, options);
  };
  await prepareCandidate({
    repository: ports.repository,
    candidate: ports.candidate,
    environment: { RELAVIUM_PACKAGE_STORE_DIR: explicit },
    home: ports.home,
    env: {},
    run: ports.run,
    pnpm,
  });
  assert.equal(
    ports.events.at(-1),
    `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir ${explicit}`,
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
      `git ${READ('/developer/ignore')}status --porcelain=v1 -z --untracked-files=all`,
      `git ${READ('/developer/ignore')}ls-files -z --cached --others --exclude-standard`,
      `git ${READ('/developer/ignore')}status --porcelain=v1 -z --untracked-files=all`,
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
    [`${READ()}ls-files -z --cached --others --exclude-standard`]: 'a.ts\0b.ts\0c.ts\0',
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

test('the production bounds are the documented ones and apply by default', () => {
  assert.deepEqual(
    { ...CANDIDATE_LIMITS },
    { files: 20_000, fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 },
  );
});

test('candidate files and the copy apply the production bounds by default', async () => {
  const names = Array.from({ length: 20_001 }, (_, index) => `f${index}.ts`).join('\0');
  const listing = git({
    [`${READ()}ls-files -z --cached --others --exclude-standard`]: names,
    'ls-files -z --deleted': '',
  });
  await assert.rejects(candidateFiles('/repository', listing.run), /CANDIDATE_FILES/u);
  // A sparse file one byte over the per-file bound is refused from its size, before any read.
  const repository = fresh('sparse');
  const descriptor = openSync(join(repository, 'large.bin'), 'w');
  try {
    ftruncateSync(descriptor, 64 * 1024 * 1024 + 1);
  } finally {
    closeSync(descriptor);
  }
  assert.throws(
    () => copyCandidateTree({ repository, destination: fresh('copy'), files: ['large.bin'] }),
    /FILE_KIND_OR_BOUND/u,
  );
});

test('the copy needs an absolute, empty destination', () => {
  const repository = fresh('repository');
  write(join(repository, 'a.ts'), 'a\n');
  assert.throws(
    () =>
      copyCandidateTree({
        repository,
        destination: relative(process.cwd(), fresh('copy')),
        files: ['a.ts'],
      }),
    /CANDIDATE_ROOT/u,
  );
  const occupied = fresh('copy');
  writeFileSync(join(occupied, 'one'), '');
  assert.throws(
    () => copyCandidateTree({ repository, destination: occupied, files: ['a.ts'] }),
    /CANDIDATE_ROOT/u,
  );
});

test('only the five engine packages may be linked as @relavium workspace packages', () => {
  // A link to another workspace package, even one inside the candidate, refuses.
  for (const owner of [join('apps', 'cli'), join('packages', 'core')]) {
    const root = linkedCandidate();
    mkdirSync(join(root, 'packages', 'ui'), { recursive: true });
    const scope = join(root, ...owner.split('/'), 'node_modules', '@relavium');
    mkdirSync(scope, { recursive: true });
    symlinkSync(join(root, 'packages', 'ui'), join(scope, 'ui'), linkKind);
    assert.throws(() => verifyCandidateLinks(root), /CANDIDATE_LINK/u, owner);
  }
});

test(
  'the excludes lookup never runs a git found in the checkout when the caller has no PATH',
  { skip: !posixModes },
  async () => {
    // With an empty PATH a spawn would look the command up in its working directory, the checkout.
    const repository = fresh('planted-git');
    const marker = join(fresh('marker'), 'ran');
    write(join(repository, 'git'), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`, 0o755);
    await globalExcludesFile({ repository, environment: { HOME: fresh('home') } }).catch(() => {});
    assert.equal(existsSync(marker), false);
  },
);

for (const [label, scope] of [
  [
    'GIT_CONFIG_COUNT',
    (ignore) => ({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: ignore,
    }),
  ],
  [
    'GIT_CONFIG_PARAMETERS',
    (ignore) => ({ GIT_CONFIG_PARAMETERS: `'core.excludesFile'='${ignore}'` }),
  ],
])
  test(`a real core.excludesFile set through ${label} is found`, async () => {
    const root = fresh('scoped');
    const ignore = join(root, 'scoped-ignore');
    write(ignore, 'secret.local\n');
    mkdirSync(join(root, 'empty-home'));
    assert.equal(
      await globalExcludesFile({
        repository: fresh('repository'),
        environment: {
          PATH: process.env.PATH,
          HOME: join(root, 'empty-home'),
          GIT_CONFIG_NOSYSTEM: '1',
          ...scope(ignore),
        },
      }),
      ignore,
    );
  });
