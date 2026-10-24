import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ManifestError } from './manifest.mjs';
import { finalizedPublicFiles, producerNodeMajor, sealPackage } from './seal.mjs';
import { ustar } from './ustar-fixture.mjs';

/** A finalized candidate: public JS only in dist, its metafile and hash record in private staging. */
function withFinalizedFixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-seal-fixture-'));
  const staging = join(root, 'staging');
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const graph = (outputs) => write('staging/metafile-esm.json', JSON.stringify({ outputs }));
  const record = (paths) => {
    const outputs = paths.map((path) => {
      const bytes = readFileSync(join(root, 'apps/cli', path));
      return {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    write(
      'staging/finalized.json',
      JSON.stringify({ version: 1, outputs, maps: [], upstreamMaps: 0 }),
    );
  };
  try {
    graph({
      'dist/index.js': {},
      'dist/index.js.map': {},
      'dist/chunk-ABC.js': {},
      'dist/chunk-ABC.js.map': {},
    });
    write('apps/cli/dist/index.js', '#!/usr/bin/env node\nimport "./chunk-ABC.js";\n');
    write('apps/cli/dist/chunk-ABC.js', 'export {};\n');
    record(['dist/index.js', 'dist/chunk-ABC.js']);
    for (const path of ['0000_first.sql', 'meta/_journal.json', 'meta/0000_snapshot.json']) {
      write(`packages/db/drizzle/${path}`, `canonical ${path}\n`);
      write(`apps/cli/drizzle/${path}`, `canonical ${path}\n`);
    }
    for (const name of ['package.json', 'README.md', 'CHANGELOG.md'])
      write(`apps/cli/${name}`, name);
    write('LICENSE', 'canonical repository license\n');
    return body({
      root,
      staging,
      write,
      graph,
      record,
      remove: (path) => rmSync(join(root, path)),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('producer runtime follows the declared toolchain independently of the fixed public Node floor', () => {
  withFinalizedFixture(({ root, write }) => {
    for (const major of [22, 24, 26]) {
      write('.nvmrc', `${major}\n`);
      assert.equal(producerNodeMajor(root), major);
    }
    for (const invalid of ['', '20', 'v24', '24.0.0', '24\n26', '101']) {
      write('.nvmrc', invalid);
      assert.throws(() => producerNodeMajor(root), /INVALID_PRODUCER_NODE/);
    }
  });
});

test('finalized seal inventory contains exact recorded JS bytes, canonical migrations and public documents', () => {
  withFinalizedFixture(({ root, staging }) => {
    const files = finalizedPublicFiles(root, staging);
    assert.deepEqual(
      [...files.keys()].sort(),
      [
        'package/dist/index.js',
        'package/dist/chunk-ABC.js',
        'package/drizzle/0000_first.sql',
        'package/drizzle/meta/_journal.json',
        'package/drizzle/meta/0000_snapshot.json',
        'package/package.json',
        'package/README.md',
        'package/CHANGELOG.md',
        'package/LICENSE',
      ].sort(),
    );
    assert.equal(
      files.get('package/dist/index.js').toString(),
      '#!/usr/bin/env node\nimport "./chunk-ABC.js";\n',
    );
    assert.equal(
      files.get('package/drizzle/0000_first.sql').toString(),
      'canonical 0000_first.sql\n',
    );
    assert.equal(files.get('package/LICENSE').toString(), 'canonical repository license\n');
    assert.equal(files.has('package/dist/metafile-esm.json'), false);
    assert.equal(files.has('package/dist/index.js.map'), false);
  });
});

for (const [name, mutate, refusal] of [
  [
    'empty compiled graph',
    ({ graph, remove }) => {
      graph({});
      remove('apps/cli/dist/index.js');
      remove('apps/cli/dist/chunk-ABC.js');
    },
    undefined,
  ],
  [
    'oversized compiled graph',
    ({ graph, write, remove }) => {
      const outputs = Array.from({ length: 257 }, (_, index) => `dist/chunk-${index}.js`);
      graph(Object.fromEntries(outputs.map((path) => [path, {}])));
      remove('apps/cli/dist/index.js');
      remove('apps/cli/dist/chunk-ABC.js');
      for (const path of outputs) write(`apps/cli/${path}`, 'export {};');
    },
    undefined,
  ],
  ...[
    'dist/nested/index.js',
    '../outside.js',
    '/dist/index.js',
    'dist/index.json',
    'dist/index space.js',
  ].map((path) => [
    `unreviewed graph output ${path}`,
    ({ graph }) => graph({ [path]: {} }),
    /PACKED_CLI_UNREVIEWED_GRAPH_OUTPUT/,
  ]),
  ['missing emitted chunk', ({ remove }) => remove('apps/cli/dist/chunk-ABC.js'), undefined],
  [
    'unlisted emitted chunk',
    ({ write }) => write('apps/cli/dist/extra.js', 'extra'),
    /PACKED_CLI_EXTRA_FINAL_OUTPUT/,
  ],
  [
    'a map left in the public package',
    ({ write }) => write('apps/cli/dist/index.js.map', '{}'),
    /PACKED_CLI_EXTRA_FINAL_OUTPUT/,
  ],
  [
    'build metadata left in the public package',
    ({ write }) => write('apps/cli/dist/metafile-esm.json', '{}'),
    /PACKED_CLI_EXTRA_FINAL_OUTPUT/,
  ],
  [
    'JS changed after the finalizer recorded it',
    ({ write }) => write('apps/cli/dist/chunk-ABC.js', 'export const late = 1;\n'),
    /PACKED_CLI_FINALIZED_RECORD_DRIFT/,
  ],
  [
    'a hash record missing an output',
    ({ record }) => record(['dist/index.js']),
    /PACKED_CLI_FINALIZED_RECORD_DRIFT/,
  ],
  ['a missing hash record', ({ remove }) => remove('staging/finalized.json'), undefined],
  ['a missing staged metafile', ({ remove }) => remove('staging/metafile-esm.json'), undefined],
  [
    'changed migration',
    ({ write }) => write('apps/cli/drizzle/0000_first.sql', 'changed'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'missing migration',
    ({ remove }) => remove('apps/cli/drizzle/0000_first.sql'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'extra copied migration',
    ({ write }) => write('apps/cli/drizzle/0001_extra.sql', 'extra'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'new uncopied canonical migration',
    ({ write }) => write('packages/db/drizzle/0001_next.sql', 'new'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  [
    'changed migration journal',
    ({ write }) => write('apps/cli/drizzle/meta/_journal.json', 'changed'),
    /PACKED_CLI_MIGRATION_COPY_CHANGED/,
  ],
  ['missing public document', ({ remove }) => remove('apps/cli/README.md'), undefined],
  [
    'oversized public document',
    ({ write }) => write('apps/cli/CHANGELOG.md', 'x'.repeat(128 * 1024 + 1)),
    /PACKED_CLI_FILE_KIND_OR_BOUND/,
  ],
  [
    'oversized emitted file',
    ({ write }) => write('apps/cli/dist/chunk-ABC.js', 'x'.repeat(8 * 1024 * 1024 + 1)),
    /PACKED_CLI_FILE_KIND_OR_BOUND/,
  ],
]) {
  test(`finalized seal refuses ${name}`, () => {
    withFinalizedFixture((fixture) => {
      mutate(fixture);
      assert.throws(() => finalizedPublicFiles(fixture.root, fixture.staging), refusal);
    });
  });
}

test(
  'finalized seal refuses a symlink masquerading as an emitted file',
  { skip: process.platform === 'win32' },
  () => {
    withFinalizedFixture(({ root, staging, remove }) => {
      remove('apps/cli/dist/chunk-ABC.js');
      symlinkSync(join(root, 'LICENSE'), join(root, 'apps/cli/dist/chunk-ABC.js'));
      assert.throws(() => finalizedPublicFiles(root, staging), /PACKED_CLI_FILE_KIND_OR_BOUND/);
    });
  },
);

const repository = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = 'a'.repeat(40);
const ORIGIN_VARIABLES = [
  'GITHUB_ACTIONS',
  'GITHUB_REPOSITORY',
  'GITHUB_WORKFLOW',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_EVENT_NAME',
  'GITHUB_SHA',
  'RELAVIUM_PACKAGE_SOURCE_SHA',
];
const GITHUB_ORIGIN = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'owner/name',
  GITHUB_WORKFLOW: 'CI',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_SHA: 'b'.repeat(40),
  RELAVIUM_PACKAGE_SOURCE_SHA: SOURCE,
};

/** Run `body` with exactly `variables` as the origin environment, restoring the job's own after. */
async function withOrigin(variables, body) {
  const saved = ORIGIN_VARIABLES.map((name) => [name, process.env[name]]);
  for (const name of ORIGIN_VARIABLES) delete process.env[name];
  Object.assign(process.env, variables);
  try {
    return await body();
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

/**
 * A finalized candidate that is not the repository holding seal.mjs: its own toolchain pins,
 * catalog, CLI manifest, migrations and documents, a private staging directory outside the
 * candidate root, and pnpm's tarball of exactly the finalized public files.
 */
async function withCandidate(body, { packageManager = 'pnpm@9.12.3' } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'relavium-seal-candidate-'));
  const root = join(temporary, 'candidate');
  const staging = join(temporary, 'private-staging');
  const artifact = join(temporary, 'artifact');
  const write = (path, bytes) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  const published = {
    name: 'relavium',
    version: '0.1.1',
    type: 'module',
    bin: { relavium: 'dist/index.js' },
    engines: { node: '>=22' },
    scripts: { start: 'node dist/index.js' },
    dependencies: { commander: '^14.0.0' },
  };
  const js = {
    'dist/index.js': '#!/usr/bin/env node\nimport "./chunk-ABC.js";\n',
    'dist/chunk-ABC.js': 'export {};\n',
  };
  const migrations = ['0000_first.sql', 'meta/_journal.json', 'meta/0000_snapshot.json'];
  try {
    write(join(root, '.nvmrc'), `${process.versions.node.split('.')[0]}\n`);
    write(join(root, 'package.json'), JSON.stringify({ packageManager }));
    write(join(root, 'pnpm-workspace.yaml'), 'packages: []\ncatalog:\n  commander: ^14.0.0\n');
    write(join(root, 'LICENSE'), 'candidate license\n');
    write(
      join(root, 'apps/cli/package.json'),
      JSON.stringify({
        ...published,
        scripts: { ...published.scripts, prepack: 'node prepack.mjs' },
        dependencies: { commander: 'catalog:' },
      }),
    );
    // The copied tree's own installation resolves `yaml` for the catalog read.
    symlinkSync(
      join(repository, 'apps/cli/node_modules'),
      join(root, 'apps/cli/node_modules'),
      'junction',
    );
    write(join(root, 'apps/cli/README.md'), 'candidate readme\n');
    write(join(root, 'apps/cli/CHANGELOG.md'), 'candidate changes\n');
    for (const [path, text] of Object.entries(js)) write(join(root, 'apps/cli', path), text);
    for (const path of migrations) {
      write(join(root, 'packages/db/drizzle', path), `candidate ${path}\n`);
      write(join(root, 'apps/cli/drizzle', path), `candidate ${path}\n`);
    }
    write(
      join(staging, 'metafile-esm.json'),
      JSON.stringify({
        outputs: Object.fromEntries(
          Object.keys(js).flatMap((path) => [
            [path, {}],
            [`${path}.map`, {}],
          ]),
        ),
      }),
    );
    write(
      join(staging, 'finalized.json'),
      JSON.stringify({
        version: 1,
        outputs: Object.entries(js).map(([path, text]) => ({
          path,
          bytes: Buffer.byteLength(text),
          sha256: createHash('sha256').update(text).digest('hex'),
        })),
        maps: [],
        upstreamMaps: 0,
      }),
    );
    const files = new Map([
      ...Object.entries(js).map(([path, text]) => [`package/${path}`, Buffer.from(text)]),
      ...migrations.map((path) => [`package/drizzle/${path}`, Buffer.from(`candidate ${path}\n`)]),
      ['package/package.json', Buffer.from(JSON.stringify(published))],
      ['package/README.md', Buffer.from('candidate readme\n')],
      ['package/CHANGELOG.md', Buffer.from('candidate changes\n')],
      ['package/LICENSE', Buffer.from('candidate license\n')],
    ]);
    const tarball = gzipSync(ustar(files));
    write(join(artifact, 'relavium-0.1.1.tgz'), tarball);
    return await body({ root, staging, artifact, tarball, files, published });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const receiptPath = (artifact) => join(artifact, 'package-test-receipt.json');

/**
 * The seal with recording stand-ins for the private manifest and symbolication, whose own tests
 * (manifest.test.mjs, symbolicate.test.mjs) run them for real.
 */
function sealWith(artifact, candidate, calls = []) {
  return sealPackage(artifact, {
    checkout: candidate.repository,
    work: join(dirname(candidate.staging), 'work'),
    ...candidate,
    ports: {
      manifest: async (options) => void calls.push(['manifest', options]),
      symbolicate: async (options) => void calls.push(['symbolicate', options]),
    },
  });
}

test('the seal binds a locally produced candidate it is given, never the repository holding seal.mjs', async () => {
  await withCandidate(async ({ root, staging, artifact, tarball, files, published }) => {
    const receipt = await withOrigin({}, () =>
      sealWith(artifact, { repository: root, staging, source: SOURCE, dirty: true }),
    );
    assert.equal(receipt.mode, 'compiled_package_test');
    assert.equal(receipt.source, SOURCE);
    assert.equal(receipt.dirty, true);
    assert.equal(receipt.packageVersion, '0.1.1');
    assert.equal(receipt.tarball, 'relavium-0.1.1.tgz');
    assert.equal(receipt.tarballSha256, createHash('sha256').update(tarball).digest('hex'));
    assert.equal(receipt.archiveBytes, tarball.length);
    assert.deepEqual(receipt.files.map((file) => file.path).sort(), [...files.keys()].sort());
    // The catalog dependency resolved from the candidate's own workspace; prepack removed.
    assert.deepEqual(receipt.package, published);
    assert.deepEqual(receipt.origin, { kind: 'local' });
    assert.deepEqual(receipt.toolchain, { node: process.version, pnpm: '9.12.3' });
    assert.deepEqual(JSON.parse(readFileSync(receiptPath(artifact), 'utf8')), receipt);
    assert.deepEqual(readdirSync(artifact).sort(), [
      'package-test-receipt.json',
      'relavium-0.1.1.tgz',
    ]);
  });
});

test('the seal records the trusted job origin and refuses a dirty source there', async () => {
  await withCandidate(async ({ root, staging, artifact }) => {
    await withOrigin(GITHUB_ORIGIN, async () => {
      await assert.rejects(
        sealWith(artifact, { repository: root, staging, source: SOURCE, dirty: true }),
        /DIRTY_SOURCE/,
      );
      assert.equal(existsSync(receiptPath(artifact)), false);
      const receipt = await sealWith(artifact, {
        repository: root,
        staging,
        source: SOURCE,
        dirty: false,
      });
      assert.deepEqual(receipt.origin, {
        kind: 'github',
        repository: 'owner/name',
        workflow: 'CI',
        runId: '42',
        runAttempt: '1',
        event: 'push',
        source: SOURCE,
      });
    });
  });
});

test('the seal refuses a candidate that pins a different pnpm, writing no receipt', async () => {
  await withCandidate(
    async ({ root, staging, artifact }) => {
      await withOrigin({}, () =>
        assert.rejects(
          sealWith(artifact, { repository: root, staging, source: SOURCE, dirty: false }),
          /pnpm@9\.12\.4/,
        ),
      );
      assert.equal(existsSync(receiptPath(artifact)), false);
    },
    { packageManager: 'pnpm@9.12.4' },
  );
});

test('the seal refuses an invalid source identity before it reads the candidate', async () => {
  await withCandidate(async ({ staging, artifact }) => {
    const missing = join(artifact, 'no-candidate');
    for (const identity of [
      { source: 'A'.repeat(40), dirty: false },
      { source: SOURCE.slice(1), dirty: false },
      { source: SOURCE, dirty: 'false' },
    ])
      await assert.rejects(
        sealWith(artifact, { repository: missing, staging, ...identity }),
        /PACKED_CLI_SOURCE_IDENTITY/,
      );
    assert.equal(existsSync(receiptPath(artifact)), false);
  });
});

test('the seal refuses archive bytes that differ from the finalized candidate', async () => {
  await withCandidate(async ({ root, staging, artifact, files }) => {
    files.set('package/LICENSE', Buffer.from('repository license\n'));
    writeFileSync(join(artifact, 'relavium-0.1.1.tgz'), gzipSync(ustar(files)));
    await withOrigin({}, () =>
      assert.rejects(
        sealWith(artifact, { repository: root, staging, source: SOURCE, dirty: false }),
        /FILE_DRIFT/,
      ),
    );
    assert.equal(existsSync(receiptPath(artifact)), false);
  });
});

test('the seal seals the private manifest after the inspection and symbolicates before any receipt', async () => {
  await withCandidate(async ({ root, staging, artifact }) => {
    const calls = [];
    const work = join(dirname(staging), 'work');
    const receipt = await withOrigin({}, () =>
      sealWith(artifact, { repository: root, staging, source: SOURCE, dirty: false }, calls),
    );
    assert.deepEqual(
      calls.map(([step]) => step),
      ['manifest', 'symbolicate'],
    );
    const [[, manifest], [, symbolicate]] = calls;
    // Both steps receive the inspected archive: the bytes the receipt then records.
    assert.equal(manifest.archive.sha256, receipt.tarballSha256);
    assert.deepEqual(manifest.archive.files, receipt.files);
    assert.deepEqual(
      { ...manifest, archive: undefined },
      {
        candidate: root,
        staging,
        checkout: root,
        source: SOURCE,
        dirty: false,
        archive: undefined,
      },
    );
    assert.deepEqual(
      { ...symbolicate, archive: undefined },
      { candidate: root, staging, checkout: root, work, archive: undefined },
    );
    assert.equal(symbolicate.archive, manifest.archive);
  });
});

test('a refused manifest or symbolication leaves no receipt, and an unproven archive reaches neither', async () => {
  for (const failing of ['manifest', 'symbolicate']) {
    await withCandidate(async ({ root, staging, artifact }) => {
      const steps = [];
      const refusal = new Error(`synthetic ${failing} refusal`);
      const step = (name) => async () => {
        steps.push(name);
        if (name === failing) throw refusal;
      };
      await withOrigin({}, () =>
        assert.rejects(
          sealPackage(artifact, {
            repository: root,
            staging,
            source: SOURCE,
            dirty: false,
            checkout: root,
            work: join(dirname(staging), 'work'),
            ports: { manifest: step('manifest'), symbolicate: step('symbolicate') },
          }),
          (error) => error === refusal,
        ),
      );
      assert.deepEqual(steps, failing === 'manifest' ? ['manifest'] : ['manifest', 'symbolicate']);
      assert.equal(existsSync(receiptPath(artifact)), false);
    });
  }
  await withCandidate(async ({ root, staging, artifact, files }) => {
    files.set('package/README.md', Buffer.from('changed\n'));
    writeFileSync(join(artifact, 'relavium-0.1.1.tgz'), gzipSync(ustar(files)));
    const calls = [];
    await withOrigin({}, () =>
      assert.rejects(
        sealWith(artifact, { repository: root, staging, source: SOURCE, dirty: false }, calls),
        /FILE_DRIFT/,
      ),
    );
    assert.deepEqual(calls, []);
  });
});

test('both steps receive the candidate, the original checkout and the dirty flag as given', async () => {
  await withCandidate(async ({ root, staging, artifact }) => {
    const calls = [];
    const checkout = join(dirname(staging), 'original-checkout');
    await withOrigin({}, () =>
      sealPackage(artifact, {
        repository: root,
        staging,
        source: SOURCE,
        dirty: true,
        checkout,
        work: join(dirname(staging), 'work'),
        ports: {
          manifest: async (options) => void calls.push(options),
          symbolicate: async (options) => void calls.push(options),
        },
      }),
    );
    const [manifest, symbolicate] = calls;
    assert.deepEqual(
      [manifest.candidate, manifest.checkout, manifest.dirty],
      [root, checkout, true],
    );
    assert.deepEqual([symbolicate.candidate, symbolicate.checkout], [root, checkout]);
  });
});

test('without ports the seal runs the real private manifest and the real symbolication', async () => {
  // The real manifest refuses this candidate's record, which stages no maps.
  await withCandidate(async ({ root, staging, artifact }) => {
    await withOrigin({}, () =>
      assert.rejects(
        sealPackage(artifact, {
          repository: root,
          staging,
          source: SOURCE,
          dirty: false,
          checkout: root,
          work: join(dirname(staging), 'work'),
        }),
        (error) => error instanceof ManifestError && error.code === 'RECORD',
      ),
    );
    assert.equal(existsSync(receiptPath(artifact)), false);
  });
  // The real symbolication reads the manifest that a stand-in never sealed.
  await withCandidate(async ({ root, staging, artifact }) => {
    await withOrigin({}, () =>
      assert.rejects(
        sealPackage(artifact, {
          repository: root,
          staging,
          source: SOURCE,
          dirty: false,
          checkout: root,
          work: join(dirname(staging), 'work'),
          ports: { manifest: async () => {} },
        }),
        (error) => error instanceof ManifestError && error.code === 'UNREADABLE',
      ),
    );
    assert.equal(existsSync(receiptPath(artifact)), false);
  });
});

test('the seal requires the checkout and a private work directory before it reads the candidate', async () => {
  await withCandidate(async ({ staging, artifact }) => {
    const missing = join(artifact, 'no-candidate');
    for (const inputs of [
      { checkout: undefined, work: '/private/work' },
      { checkout: 'relative', work: '/private/work' },
      { checkout: '/checkout', work: undefined },
      { checkout: '/checkout', work: 'relative' },
    ]) {
      await assert.rejects(
        sealPackage(artifact, {
          repository: missing,
          staging,
          source: SOURCE,
          dirty: false,
          ...inputs,
        }),
        /PACKED_CLI_SEAL_INPUTS/,
      );
    }
  });
});
