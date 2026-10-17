import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { permanentFiles } from './mutations.mjs';
import {
  aliases,
  digest,
  instrument,
  rejectUnknownAlias,
  relativeSource,
} from './source-graph.mjs';
import {
  assertNativeReadiness,
  assertPermanentWorkload,
  ordinaryPhaseTimeoutMs,
  permanentPhaseTimeoutMs,
  permanentWorkload,
} from './workload.mjs';

test('supported shared, llm and core exports map to exact owned sources, with unknown aliases refused', () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  for (const name of ['shared', 'llm', 'core']) {
    const info = JSON.parse(
      readFileSync(join(repository, `packages/${name}/package.json`), 'utf8'),
    );
    for (const [subpath, target] of Object.entries(info.exports)) {
      const specifier =
        subpath === '.' ? `@relavium/${name}` : `@relavium/${name}/${subpath.slice(2)}`;
      const source = `packages/${name}/src/${target.import.slice('./dist/'.length).replace(/\.js$/, '.ts')}`;
      assert.equal(aliases[specifier], source);
      assert.equal(relativeSource({ sourceRoot: repository }, specifier), join(repository, source));
      assert.doesNotThrow(() => rejectUnknownAlias(specifier));
    }
  }
  for (const specifier of [
    '@relavium/shared/private',
    '@relavium/shared/../core',
    '@relavium/llm/private',
    '@relavium/llm/scrub-secrets/private',
    '@relavium/core/tool-dispatch-error/private',
    '@relavium/unknown',
  ])
    assert.throws(() => rejectUnknownAlias(specifier), /USAGE_UNKNOWN_WORKSPACE_ALIAS/);
});

test('the complete native/scale workload has its own calculated bound and exact inventory', () => {
  assert.equal(ordinaryPhaseTimeoutMs, 300_000);
  assert.equal(permanentPhaseTimeoutMs, 300_000 + 71 * 20_000 + 600_000);
  const result = {
    tests: Array.from({ length: 446 }),
    runtime: { nativeChildren: 71, readinessTimeoutChildren: 1 },
  };
  assert.doesNotThrow(() => assertPermanentWorkload(result));
  for (const count of [0, 440, 445, 447]) {
    assert.throws(
      () => assertPermanentWorkload({ ...result, tests: Array.from({ length: count }) }),
      /Permanent case inventory drift/,
    );
  }
  for (const count of [0, 69, 70, 72]) {
    assert.throws(
      () =>
        assertPermanentWorkload({
          ...result,
          runtime: { ...result.runtime, nativeChildren: count },
        }),
      /Permanent native-child inventory drift/,
    );
  }
  for (const count of [0, 2])
    assert.throws(
      () =>
        assertPermanentWorkload({
          ...result,
          runtime: { ...result.runtime, readinessTimeoutChildren: count },
        }),
      /Missing\/extra native timeout control/,
    );
});

test('the pinned permanent inventory matches actual installed Vitest collection', () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'relavium-usage-inventory-'));
  const output = join(scratch, 'collected.json');
  try {
    // Vitest's optional --json argument is a filename, including the literal string "true".
    // Always give an owned output path: no filter may become the reporter's destination.
    execFileSync(
      process.execPath,
      [
        join(repository, 'node_modules/vitest/vitest.mjs'),
        'list',
        `--json=${output}`,
        ...permanentFiles,
      ],
      { cwd: repository, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: 'pipe' },
    );
    const collected = JSON.parse(readFileSync(output, 'utf8'));
    assert.ok(Array.isArray(collected));
    assert.equal(
      collected.length,
      permanentWorkload.cases,
      'Permanent collected case inventory drift',
    );
    assert.deepEqual(
      [...new Set(collected.map((item) => item.file))].sort(),
      permanentFiles.map((file) => join(repository, file)).sort(),
      'Permanent collected file inventory drift',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('only the loaded-but-unready timeout control may omit a real readiness barrier', () => {
  const child = { pid: 123, callerPid: 456, mode: 'readiness-timeout-control', stage: 'spawn' };
  const records = [
    child,
    { ...child, stage: 'not-ready', kind: 'WAITING' },
    { ...child, stage: 'readiness-timeout' },
    { ...child, stage: 'close', signal: 'SIGKILL', code: null },
  ];
  assert.doesNotThrow(() => assertNativeReadiness(child, records));
  for (let index = 0; index < records.length; index++)
    assert.throws(() =>
      assertNativeReadiness(
        child,
        records.filter((_, i) => i !== index),
      ),
    );
  for (const changed of [
    records.map((r) => (r.stage === 'not-ready' ? { ...r, kind: 'CUT' } : r)),
    records.map((r) => (r.stage === 'close' ? { ...r, signal: null, code: 0 } : r)),
    records.map((r) => (r.stage === 'readiness-timeout' ? { ...r, pid: 124 } : r)),
    records.map((r) => (r.stage === 'not-ready' ? { ...r, callerPid: 457 } : r)),
    [...records, { ...child, stage: 'barrier', kind: 'CUT' }],
    [records[0], records[2], records[1], records[3]],
  ])
    assert.throws(() => assertNativeReadiness(child, changed));
  const ordinary = { ...child, mode: 'lock-release' };
  assert.throws(
    () => assertNativeReadiness(ordinary, records),
    /Native child did not reach real barrier/,
  );
  assert.doesNotThrow(() =>
    assertNativeReadiness(ordinary, [{ ...ordinary, stage: 'barrier', kind: 'LOCKED' }]),
  );
});

test('compiler reuse is state-local and never bypasses physical source or compiler admission', () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-compiler-reuse-')));
  const original = Module.prototype.require;
  let loads = 0;
  try {
    writeFileSync(join(scratch, 'package.json'), '{"type":"module"}');
    symlinkSync(
      join(repository, 'node_modules'),
      join(scratch, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const path = join(scratch, 'owned.ts');
    const source = 'export const value: number = 1;';
    writeFileSync(path, source);
    const compiler = realpathSync(
      createRequire(join(scratch, 'package.json')).resolve('typescript'),
    );
    const compilerBytes = readFileSync(compiler);
    const state = {
      sourceRoot: scratch,
      files: new Map([[path, { bytes: Buffer.byteLength(source), sha256: digest(source) }]]),
      external: new Map([
        [compiler, { path: compiler, bytes: compilerBytes.length, sha256: digest(compilerBytes) }],
      ]),
      infrastructure: new Map(),
      admitted: new Set(),
      evaluationDirectory: scratch,
      evaluationHelper: new URL('./evaluation.mjs', import.meta.url).href,
      manifestSha256: 'test',
      phase: 'fixed',
      mutationId: 'compiler-control',
    };
    Module.prototype.require = function observedRequire(specifier) {
      if (specifier === 'typescript') loads++;
      return original.call(this, specifier);
    };
    const first = instrument(state, path);
    assert.match(first.code, /value = 1/);
    assert.deepEqual(instrument(state, path), first);
    assert.equal(loads, 1);
    assert.match(
      readFileSync(join(scratch, `${process.pid}.dependencies.jsonl`), 'utf8'),
      /dependency-load-verification/,
    );
    const unownedCompiler = { ...state, external: new Map(), admitted: new Set() };
    assert.throws(() => instrument(unownedCompiler, path), /USAGE_SOURCE_ESCAPE/);
    assert.equal(loads, 1);
    writeFileSync(path, source.replace('1;', '2;'));
    assert.throws(() => instrument(state, path), /USAGE_SOURCE_BYTES_CHANGED/);
  } finally {
    Module.prototype.require = original;
    rmSync(scratch, { recursive: true, force: true });
  }
});
