import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMIT, TREE, fresh } from './candidate-fixture.mjs';
import { CONTAINER_LIMITS } from './container.mjs';
import { ciphertextName } from './custody.mjs';
import { sha256 } from './files.mjs';
import {
  CIPHERTEXT_BYTES,
  RELEASE_BINDING_FILE,
  ciphertextFileName,
  serializeReleaseBinding,
  tarballName,
  validateReleaseBinding,
  verifyRetainedCandidate,
} from './release-binding.mjs';
import { ReleaseGuardError, requireReleaseCandidate } from './release-guard-core.mjs';
import { PRODUCTION_RECIPIENT_ROOT, SYNTHETIC_SOURCE } from './release-recipient.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));
/** Tracked and new, unignored source files, as repository-relative POSIX paths. */
const tracked = spawnSync(
  'git',
  [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    '*.mjs',
    '*.cjs',
    '*.js',
    '*.ts',
    '*.tsx',
    '*.mts',
    '*.yml',
    '*.yaml',
    // Package scripts can name a module too.
    'package.json',
    '*/package.json',
  ],
  { cwd: repository, encoding: 'utf8' },
)
  .stdout.split('\0')
  .filter(Boolean);
/** Test, fixture and maintainer-only files: everything else is product or tooling code. */
const isTestOnly = (path) =>
  /\.test\.[cm]?[jt]sx?$/u.test(path) ||
  /-fixture\.mjs$/u.test(path) ||
  /(?:^|\/)(?:test|tests|__tests__|lint-fixtures)\//u.test(path) ||
  path.startsWith('tools/cli-package/custody-fixtures/');
const code = tracked.filter((path) => !isTestOnly(path));
const read = (path) => readFileSync(join(repository, path), 'utf8');
/** The code files whose text matches `pattern`. @param {RegExp} pattern */
const naming = (pattern) => code.filter((path) => pattern.test(read(path))).sort();

test('the scan sees the custody modules and leaves the tests out', () => {
  for (const path of [
    'tools/cli-package/custody.mjs',
    'tools/cli-package/release-custody.mjs',
    'tools/cli-package/release-guard-core.mjs',
    '.github/workflows/release.yml',
  ]) {
    assert.ok(code.includes(path), path);
  }
  for (const path of [
    'tools/cli-package/release-custody.test.mjs',
    'tools/cli-package/release-fixture.mjs',
    'tools/cli-package/custody-fixtures/generate.mjs',
  ]) {
    assert.ok(tracked.includes(path) && !code.includes(path), path);
  }
});

test('no product or tooling code reaches a test fixture, and only the loader reads the fixture pins', () => {
  assert.deepEqual(naming(/[A-Za-z0-9_-]+-fixture\.mjs/u), []);
  assert.deepEqual(naming(/custody-fixtures/u), ['tools/cli-package/release-recipient.mjs']);
});

/**
 * Whether `text` mentions a file named `name` anywhere, quoted or not, comments included: a package script
 * runs in its package and a workflow step in its working directory, and a template literal can build the
 * rest of the path, so no resolution is attempted. JavaScript and percent escapes are decoded, separators
 * normalized and case ignored first. Only one tracked file has the name, so any mention is a reference.
 * @param {string} text @param {string} name
 */
function namesFile(text, name) {
  const decoded = text
    .replace(/\\\r?\n/gu, '')
    .replace(/\\x([0-9a-f]{2})|\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/giu, (_, x, braced, u) =>
      String.fromCodePoint(Number.parseInt(x ?? braced ?? u, 16)),
    )
    .replace(/%([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll('\\', '/')
    .toLowerCase();
  const escaped = name.toLowerCase().replaceAll('.', '\\.');
  return new RegExp(`(?<![\\w$.-])${escaped}(?![\\w$.-])`, 'u').test(decoded);
}

test('the reference match finds every spelling of the name, and only that name', () => {
  for (const text of [
    "import { encryptOnce } from '../custody.mjs';",
    'const m = await import("../../cli-package/custody.mjs?v=1");',
    "import { encryptOnce } from './custody.mjs#fragment';",
    "import { encryptOnce } from './custody%2Emjs';",
    "import { encryptOnce } from './%63ustody.mjs';",
    "import { encryptOnce } from './custody\\u002emjs';",
    "import { encryptOnce } from './custody\\x2emjs';",
    "import { encryptOnce } from './cus\\u{74}ody.mjs';",
    "const url = new URL('custody.mjs', import.meta.url);",
    "const url = new URL('.\\\\custody.mjs', import.meta.url);",
    "const url = new URL('Custody.mjs', import.meta.url);",
    'const m = (here, base) => import(`${join(here, base)}/custody.mjs`);',
    'run: node -e "import(\'./tools/cli-package/custody.mjs\')"',
    '"a": "node --import ../../tools/cli-package/custody.mjs run.mjs"',
    '"b": "node -e \\"import(process.argv[1])\\" ../tools/cli-package/custody.mjs"',
    'run: node tools/cli-package/custody.mjs',
    '// encryptOnce lives in custody.mjs',
    "export * as custody from '../../tools/cli-package/custody.mjs';",
    'require(`./custody.mjs`)',
  ]) {
    assert.equal(namesFile(text, 'custody.mjs'), true, text);
  }
  for (const text of [
    "import { refuseCustody } from './custody-error.mjs';",
    "import { encryptCandidate } from './release-custody.mjs';",
    "import { x } from './custody.mjs.bak';",
    "import { x } from './my-custody.mjs';",
    "import { x } from './custodyxmjs';",
  ]) {
    assert.equal(namesFile(text, 'custody.mjs'), false, text);
  }
});

test('only the release gate refers to custody.mjs, by any spelling', () => {
  assert.equal(
    tracked.filter((path) => posix.basename(path).toLowerCase() === 'custody.mjs').length,
    1,
  );
  assert.deepEqual(code.filter((path) => namesFile(read(path), 'custody.mjs')).sort(), [
    'tools/cli-package/release-custody.mjs',
  ]);
});

test('the loader takes no argument, and no product or tooling code reaches its test seam', () => {
  // Permanent: these controls stay when Step 9d updates the interim one below.
  assert.deepEqual(naming(/\bloadRecipientForTests\b/u), [
    'tools/cli-package/release-recipient.mjs',
  ]);
  assert.deepEqual(naming(/\bloadProductionRecipient\s*\(\s*[^)\s]/u), []);
});

test('no product path or workflow names a release module yet', () => {
  // Interim: Step 9d wires the release modules into the originating job and updates this control.
  assert.deepEqual(naming(/release-(?:custody|binding|recipient)\.mjs/u), [
    'tools/cli-package/release-binding.mjs',
    'tools/cli-package/release-custody.mjs',
  ]);
});

/**
 * Whether every dynamic import in `source` takes exactly one string literal, so that a closure scan
 * reads every module the source can load.
 * @param {string} source
 */
function dynamicImportsAreLiteral(source) {
  for (const match of source.matchAll(/\bimport\s*\(/gu)) {
    const rest = source.slice(match.index + match[0].length);
    if (!/^\s*(['"])[^'"\n]+\1\s*\)/u.test(rest)) return false;
  }
  return true;
}

test('a dynamic import is admitted only as one string literal', () => {
  for (const source of [
    "await import('./archive.mjs');",
    'import("node:fs")',
    "import ( './x.mjs' )",
  ]) {
    assert.equal(dynamicImportsAreLiteral(source), true, source);
  }
  for (const source of [
    "import('node:child' + '_process')",
    "import('./' + name)",
    'import(`./x.mjs`)',
    'import(name)',
    "import('./x.mjs', { with: {} })",
  ]) {
    assert.equal(dynamicImportsAreLiteral(source), false, source);
  }
});

/**
 * Every module specifier `source` names: each string literal right after `from` or `import`, with or
 * without a parenthesis, whatever the spacing, so a compact, spaced or multi-line import is read too.
 * @param {string} source
 */
function specifiersOf(source) {
  // A keyword, never a member call such as `Buffer.from('…')`.
  return [...source.matchAll(/(?<![.\w$])(?:from|import)\s*\(?\s*(['"])([^'"\n]+)\1/gu)].map(
    (match) => match[2],
  );
}

test('the specifier scan reads every spelling of an import', () => {
  assert.deepEqual(
    specifiersOf(
      [
        "import { a } from './a.mjs';",
        "import{b}from'./b.mjs';",
        "import 'node:fs';",
        "import {\n  c, // the container's\n} from './c.mjs';",
        "export * as d from './d.mjs';",
        "export { e } from './e.mjs';",
        "const f = await import ( 'node:child_process' );",
        'const g = import("./g.mjs");',
        "const magic = Buffer.from('ustar\\0');",
      ].join('\n'),
    ),
    [
      './a.mjs',
      './b.mjs',
      'node:fs',
      './c.mjs',
      './d.mjs',
      './e.mjs',
      'node:child_process',
      './g.mjs',
    ],
  );
});

/** Every specifier a module's import closure reaches, relative files followed. @param {string} entry */
function closure(entry) {
  const seen = new Set();
  const specifiers = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, 'utf8');
    for (const specifier of specifiersOf(source)) {
      specifiers.add(specifier);
      if (specifier.startsWith('.')) visit(join(dirname(path), specifier));
    }
  };
  visit(join(here, entry));
  return {
    files: [...seen].map((path) => relative(here, path).split('\\').join('/')).sort(),
    specifiers: [...specifiers].sort(),
  };
}

test("the binding receipt's closure starts no process, so reuse makes no GnuPG call", () => {
  const { files, specifiers } = closure('release-binding.mjs');
  assert.deepEqual(files, [
    'archive.mjs',
    'custody-error.mjs',
    'files.mjs',
    'release-binding.mjs',
    'release-recipient.mjs',
    'ustar.mjs',
  ]);
  // Every specifier is one of those files or an allowed builtin: no package, no process module.
  const builtins = [
    'node:assert/strict',
    'node:buffer',
    'node:crypto',
    'node:fs',
    'node:path',
    'node:url',
    'node:util',
    'node:zlib',
  ];
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('./') || builtins.includes(specifier), specifier);
  }
  // Nor can a closure file reach a process or a module without a literal import.
  for (const file of files) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.doesNotMatch(
      source,
      /\b(?:getBuiltinModule|createRequire|process\.binding|process\.dlopen|process\.execve)\b|\brequire\s*\(/u,
      file,
    );
    assert.equal(dynamicImportsAreLiteral(source), true, file);
  }
  // The scan reads the imports it claims to: the gate's closure reaches GnuPG.
  const gate = closure('release-custody.mjs');
  for (const reached of ['custody.mjs', 'gnupg.mjs', 'process.mjs', 'container.mjs']) {
    assert.ok(gate.files.includes(reached), reached);
  }
  assert.ok(gate.specifiers.includes('node:child_process'));
});

test('no production recipient is committed in Wave 3', () => {
  // Interim: Wave 4b commits the recipient directory and updates this control.
  assert.equal(existsSync(PRODUCTION_RECIPIENT_ROOT), false);
  const listed = spawnSync(
    'git',
    ['ls-files', '--', posix.join('tools/cli-package', 'release-recipient')],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, '');
});

test('the interim release guard still refuses a complete, valid synthetic candidate', () => {
  const directory = fresh('guarded-candidate');
  mkdirSync(directory);
  const tarball = Buffer.from('a synthetic tarball, never a package\n');
  const ciphertext = Buffer.from('synthetic ciphertext bytes');
  const pins = { primary: '4'.repeat(40), subkey: '5'.repeat(40) };
  const expected = { scope: 'synthetic', pins, packageVersion: '0.1.1' };
  const receipt = validateReleaseBinding(
    {
      version: 1,
      kind: 'release_binding',
      packageVersion: '0.1.1',
      source: { ...SYNTHETIC_SOURCE, dirty: true },
      tarball: { name: tarballName('0.1.1'), bytes: tarball.length, sha256: sha256(tarball) },
      ciphertext: {
        name: ciphertextFileName('0.1.1'),
        bytes: ciphertext.length,
        sha256: sha256(ciphertext),
      },
      recipient: pins,
      toolchain: {
        node: 'v22.23.1',
        pnpm: '9.12.3',
        typescript: '5.6.3',
        tsup: '8.3.5',
        esbuild: '0.24.0',
        gnupg: '2.5.21',
      },
      target: 'node22',
      inputs: { 'package.json': 'a'.repeat(64) },
      mapCheck: { status: 'complete' },
      origin: {
        kind: 'github',
        repository: 'example/relavium',
        workflow: 'release',
        runId: '1',
        runAttempt: '1',
        event: 'push',
        source: SYNTHETIC_SOURCE.commit,
      },
    },
    expected,
  );
  writeFileSync(join(directory, RELEASE_BINDING_FILE), serializeReleaseBinding(receipt));
  writeFileSync(join(directory, tarballName('0.1.1')), tarball);
  writeFileSync(join(directory, ciphertextFileName('0.1.1')), ciphertext);
  // The candidate is complete and reusable as it stands, and the guard still refuses it.
  verifyRetainedCandidate({ directory, expected });
  assert.throws(
    () => requireReleaseCandidate(directory),
    (error) => error instanceof ReleaseGuardError && error.code === 'RELEASE_CUSTODY_UNAVAILABLE',
  );
});

test('the constants the release modules restate equal their sources', () => {
  for (const version of ['0.1.1', '1.2.3-rc.1', '2.0.0+build.5']) {
    assert.equal(ciphertextFileName(version), ciphertextName(version));
  }
  // custody.mjs keeps its overhead private: read it from the source, so both halves have a source.
  const overhead = /^const CIPHERTEXT_OVERHEAD = (\d+) \* (\d+);$/mu.exec(
    read('tools/cli-package/custody.mjs'),
  );
  assert.ok(overhead, 'custody.mjs no longer declares CIPHERTEXT_OVERHEAD as a product');
  assert.equal(
    CIPHERTEXT_BYTES,
    CONTAINER_LIMITS.totalBytes + Number(overhead[1]) * Number(overhead[2]),
  );
  assert.deepEqual(SYNTHETIC_SOURCE, { commit: COMMIT, tree: TREE });
});
