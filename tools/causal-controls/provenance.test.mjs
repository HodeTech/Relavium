import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../usage-coverage-controls/source-graph.mjs';
import { mutations as filesystemControls } from '../fs-policy-controls/mutations.mjs';
import { mutations as secretsControls } from '../secrets-controls/mutations.mjs';
import {
  captureOwnedTools,
  verifyOwnedTools,
  mergeFiles,
  assertEvaluations,
  selectControls,
  phaseEnvironment,
  exactReplacement,
  assertSelectedAnchors,
  assertInventories,
} from './provenance.mjs';
const roots = ['tools/causal-controls', 'tools/secrets-controls'];
function fixture(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'causal-provenance-')));
  try {
    const repo = join(root, 'repo'),
      graph = join(root, 'graph');
    for (const path of roots) {
      mkdirSync(join(repo, path), { recursive: true });
      writeFileSync(join(repo, path, 'helper.mjs'), 'original');
    }
    return fn({ root, repo, graph });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('physical capture closes both own roots and refuses missing/added/deleted/changed helpers', () => {
  fixture(({ repo, graph }) => {
    const files = captureOwnedTools(repo, graph, roots);
    assert.equal(files.length, 2);
    assert.doesNotThrow(() => verifyOwnedTools(graph, roots, files));
    for (const root of roots) {
      const helper = join(graph, root, 'helper.mjs');
      writeFileSync(helper, 'drift');
      assert.throws(() => verifyOwnedTools(graph, roots, files));
      writeFileSync(helper, 'original');
      const added = join(graph, root, 'new.mjs');
      writeFileSync(added, 'added');
      assert.throws(() => verifyOwnedTools(graph, roots, files));
      unlinkSync(added);
      unlinkSync(helper);
      assert.throws(() => verifyOwnedTools(graph, roots, files));
      writeFileSync(helper, 'original');
    }
    assert.throws(() => mergeFiles(files, files), /Duplicate/);
  });
});
test('owned helpers and redirected root directories cannot be symlinked', () => {
  fixture(({ root, repo, graph }) => {
    const helper = join(repo, roots[0], 'helper.mjs');
    unlinkSync(helper);
    writeFileSync(join(root, 'foreign.mjs'), 'borrowed');
    symlinkSync(join(root, 'foreign.mjs'), helper);
    assert.throws(() => captureOwnedTools(repo, graph, roots), /physical/);
  });
});
test('target body, thread, source hash and physical evaluation path are independent requirements', () => {
  fixture(({ repo, graph }) => {
    const files = captureOwnedTools(repo, graph, roots),
      target = files[0];
    const entry = {
      relativePath: target.path,
      rawSha256: target.sha256,
      physicalPath: join(graph, target.path),
      stage: 'module-body-entry',
      threadId: 0,
    };
    assert.doesNotThrow(() => assertEvaluations([entry], { files }, target.path, graph));
    for (const change of [
      { stage: 'transform' },
      { threadId: 1 },
      { rawSha256: 'wrong' },
      { physicalPath: join(repo, target.path) },
      { physicalPath: join(repo, 'dist/index.js') },
      { relativePath: 'foreign.mjs' },
    ])
      assert.throws(() =>
        assertEvaluations([{ ...entry, ...change }], { files }, target.path, graph),
      );
  });
});
test('native child and target need same pinned child PID, parent link and dependency receipt', () => {
  fixture(({ repo, graph }) => {
    const parentPath = 'tools/causal-controls/parent.mjs',
      programPath = 'tools/causal-controls/worker.mjs';
    writeFileSync(join(repo, parentPath), 'parent');
    writeFileSync(join(repo, programPath), 'worker');
    const files = captureOwnedTools(repo, graph, roots),
      target = files.find((entry) => entry.path === 'tools/causal-controls/helper.mjs');
    assert.ok(target);
    const body = (file, pid, ppid) => ({
      relativePath: file.path,
      rawSha256: file.sha256,
      physicalPath: join(graph, file.path),
      stage: 'module-body-entry',
      threadId: 0,
      pid,
      ppid,
    });
    const parent = files.find((entry) => entry.path === parentPath),
      program = files.find((entry) => entry.path === programPath);
    assert.ok(parent && program);
    const records = [
      body(parent, 11, 1),
      body(target, 11, 1),
      body(target, 12, 11),
      body(program, 12, 11),
    ];
    const pin = { path: '/pinned/compiler.js', sha256: 'pinned', bytes: 7 };
    const native = {
      parent: parentPath,
      program: programPath,
      dependencyRecords: [{ ...pin, pid: 12, stage: 'dependency-load-verification' }],
      dependencies: { files: [pin] },
    };
    assert.doesNotThrow(() => assertEvaluations(records, { files }, target.path, graph, native));
    for (const [candidate, options] of [
      [records.filter((entry) => entry.relativePath !== programPath), native],
      [
        records.filter((entry) => !(entry.relativePath === target.path && entry.pid === 12)),
        native,
      ],
      [
        records.map((entry) =>
          entry.relativePath === programPath ? { ...entry, ppid: 99 } : entry,
        ),
        native,
      ],
      [records, { ...native, dependencyRecords: [] }],
      [
        records,
        { ...native, dependencyRecords: [{ ...native.dependencyRecords[0], sha256: 'wrong' }] },
      ],
    ])
      assert.throws(() => assertEvaluations(candidate, { files }, target.path, graph, options));
  });
});
test('unknown, ambiguous, empty and ineffective selection refuse before work', () => {
  const entry = { id: 'declared', before: 'old', after: 'new', expectedTests: 1 };
  assert.deepEqual(selectControls([entry], ['--mechanism', 'declared']), [entry]);
  for (const [entries, args] of [
    [[entry], ['--mechanism', 'unknown']],
    [[entry], ['--mechanism']],
    [[], []],
    [[entry, entry], []],
    [[{ ...entry, before: '' }], []],
    [[{ ...entry, after: 'old' }], []],
    [[{ ...entry, expectedTests: 0 }], []],
  ])
    assert.throws(() => selectControls(entries, args));
});
test('secrets child excludes ambient credentials, node injection and operator home; filesystem stays equivalent', () => {
  fixture(({ root }) => {
    const previous = process.env.RELAVIUM_CAUSAL_TEST_SECRET;
    process.env.RELAVIUM_CAUSAL_TEST_SECRET = 'opaque';
    try {
      const env = phaseEnvironment('secrets', '/owned/runtime.json', root);
      assert.equal(env.RELAVIUM_CAUSAL_TEST_SECRET, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.HOME, join(root, 'home'));
      assert.equal(env.RELAVIUM_USAGE_RUNTIME, '/owned/runtime.json');
      const actual = phaseEnvironment('filesystem', '/owned/runtime.json', root);
      const expected = {
        ...process.env,
        CI: 'true',
        NO_COLOR: '1',
        RELAVIUM_USAGE_RUNTIME: '/owned/runtime.json',
      };
      // A failed equivalence guard must never print inherited operational/credential values.
      assert.equal(Object.keys(actual).sort().join('\n'), Object.keys(expected).sort().join('\n'));
      assert.equal(
        Object.keys(expected).every((name) => actual[name] === expected[name]),
        true,
      );
    } finally {
      if (previous === undefined) delete process.env.RELAVIUM_CAUSAL_TEST_SECRET;
      else process.env.RELAVIUM_CAUSAL_TEST_SECRET = previous;
    }
  });
});
test('both family wrappers select the same shared runner with exact closure roots', () => {
  for (const [family, kind] of [
    ['fs-policy-controls', 'filesystem'],
    ['secrets-controls', 'secrets'],
  ]) {
    const text = readFileSync(new URL(`../${family}/check.mjs`, import.meta.url), 'utf8');
    assert.ok(text.includes("import { runControls } from '../causal-controls/run.mjs'"));
    assert.ok(text.includes(`evidenceKind: '${kind}'`));
    assert.ok(text.includes(`toolRoots: ['tools/causal-controls', 'tools/${family}']`));
  }
});

test('exact mutation rejects absent/ambiguous anchors and full phase inventories must remain identical', () => {
  const control = { id: 'sample', before: 'old', after: 'new' };
  assert.equal(exactReplacement(Buffer.from('prefix old suffix'), control), 'prefix new suffix');
  for (const text of ['absent', 'old old'])
    assert.throws(() => exactReplacement(Buffer.from(text), control), /anchor drift/);
  const fixed = { inventory: ['suite:negative', 'suite:positive'] };
  assert.doesNotThrow(() => assertInventories(fixed, { ...fixed }, { ...fixed }));
  assert.throws(
    () => assertInventories(fixed, { inventory: ['suite:negative'] }, fixed),
    /Mutated workload/,
  );
  assert.throws(
    () => assertInventories(fixed, fixed, { inventory: ['suite:changed', 'suite:positive'] }),
    /Restored workload/,
  );
});
test('selected anchor preflight audits every copied target before a phase', () => {
  fixture(({ repo, graph }) => {
    const files = captureOwnedTools(repo, graph, roots);
    const controls = files.map((entry, index) => ({
      id: `anchor-${index}`,
      path: entry.path,
      before: 'original',
    }));
    assert.doesNotThrow(() => assertSelectedAnchors(controls, graph, files));
    assert.throws(
      () =>
        assertSelectedAnchors([{ ...controls[0], before: 'missing' }, controls[1]], graph, files),
      /anchor-0: exact source anchor drift/,
    );
    writeFileSync(join(graph, controls[1].path), 'original original');
    const duplicateFiles = files.map((entry) =>
      entry.path === controls[1].path
        ? { ...entry, bytes: 17, sha256: digest(Buffer.from('original original')) }
        : entry,
    );
    assert.throws(
      () => assertSelectedAnchors(controls, graph, duplicateFiles),
      /anchor-1: exact source anchor drift/,
    );
    assert.throws(
      () => assertSelectedAnchors([{ ...controls[0], path: 'outside.ts' }], graph, files),
      /target outside source closure/,
    );
  });
});
test('every declared filesystem and secrets anchor matches current production source', () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  for (const controls of [filesystemControls, secretsControls]) {
    const files = [...new Set(controls.map((control) => control.path))].map((path) => {
      const bytes = readFileSync(join(repository, path));
      return { path, bytes: bytes.length, sha256: digest(bytes) };
    });
    assertSelectedAnchors(controls, repository, files);
  }
});

test('secrets workload corrections retain independent complete-count and reader-witness pins', () => {
  assert.equal(secretsControls.length, 53);
  assert.equal(
    secretsControls.reduce((count, control) => count + 1 + (control.witnesses ?? []).length, 0),
    310,
  );
  for (const [id, file, expectedTests] of [
    ['run-default-secret-reader', 'apps/cli/src/commands/run.test.ts', 84],
    ['snapshot-run-warning', 'apps/cli/src/commands/run.test.ts', 84],
    ['gate-consumed-stdin-prompt-authority', 'apps/cli/src/commands/gate.test.ts', 73],
    ['export-command-review-notice', 'apps/cli/src/commands/chat-export.test.ts', 17],
  ]) {
    const control = secretsControls.find((entry) => entry.id === id);
    assert.ok(control, `${id}: missing control`);
    assert.deepEqual(control.files, [file]);
    assert.equal(control.expectedTests, expectedTests, `${id}: complete workload drift`);
  }
  for (const [id, files, expectedTests] of [
    [
      'diagnostic-residual-scrub',
      ['apps/cli/src/render/sanitize.test.ts', 'apps/cli/src/process/render-error.test.ts'],
      163,
    ],
    ...['prefix-before-redaction', 'normalized-secret-probe', 'non-query-before-query'].map(
      (id) => [
        id,
        [
          'packages/llm/src/llm-error.test.ts',
          'apps/cli/src/render/sanitize.test.ts',
          'apps/cli/src/process/render-error.test.ts',
        ],
        261,
      ],
    ),
    ...[
      'core-modern-key-alphabet',
      'core-joined-credential-spans',
      'core-joined-original-boundary',
      'core-split-scheme-label',
      'core-split-header-label',
      'core-raw-password-userinfo',
      'core-joined-original-boundary-recovery',
    ].map((id) => [id, ['packages/core/src/tools/bounding.test.ts'], 136]),
    ...[
      'diagnostic-joined-before-masking',
      'diagnostic-joined-original-boundary',
      'diagnostic-split-header-label',
      'diagnostic-raw-password-userinfo',
      'diagnostic-joined-original-boundary-recovery',
    ].map((id) => [id, ['packages/llm/src/scrub-secrets.test.ts'], 84]),
  ]) {
    const selected = secretsControls.find((entry) => entry.id === id);
    assert.ok(selected, `${id}: missing redaction control`);
    assert.deepEqual(selected.files, files);
    assert.equal(selected.expectedTests, expectedTests, `${id}: complete workload drift`);
  }
  for (const id of [
    'core-joined-original-boundary-recovery',
    'diagnostic-joined-original-boundary-recovery',
  ]) {
    const recovery = secretsControls.find((entry) => entry.id === id);
    assert.ok(recovery, `${id}: missing original-boundary recovery`);
    assert.equal(recovery.marker, 'SECRETS_B2_ORIGINAL_BOUNDARY');
    assert.deepEqual(
      [recovery.target, ...recovery.witnesses.map((witness) => witness.target)],
      ['sk-proj-', 'AIza'].flatMap((prefix) =>
        ['\n', '\t'].map(
          (separator) =>
            `keeps the original boundary after an embedded greedy prefix ${prefix} (${JSON.stringify(separator)})`,
        ),
      ),
    );
    assert.ok(recovery.witnesses.every(({ marker }) => marker === 'SECRETS_B2_ORIGINAL_BOUNDARY'));
  }
  const reader = secretsControls.find((entry) => entry.id === 'run-default-secret-reader');
  assert.equal(
    reader.target,
    'uses the real native default reader once and suppresses an injected gate selector',
  );
  assert.equal(reader.marker, 'SECRETS_CAUSAL_RUN_DEFAULT_READER');
  assert.deepEqual(reader.witnesses, [
    {
      target:
        'uses the real structural default reader once and suppresses an injected gate selector',
      marker: 'SECRETS_CAUSAL_RUN_DEFAULT_READER',
    },
  ]);
});
