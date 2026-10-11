import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportAcceptanceEvidence } from './export.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relavium-evidence-export-'));
  const repository = join(root, 'repository');
  const scratch = join(root, 'scratch');
  mkdirSync(repository);
  mkdirSync(scratch);
  const put = (name, data) => {
    const p = join(scratch, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, data);
  };
  return { root, repository, scratch, put, directory: join(root, 'artifacts') };
}
test('exports failed-run metadata and module journals without graph/cache/native bytes', () => {
  const f = fixture();
  try {
    f.put('summary.json', '{"complete":false}');
    f.put('mechanism/mutated/cases.json', 'semantic-failure');
    f.put('mechanism/mutated/evaluation/123.ndjson', 'module-entry');
    f.put('mechanism/graph/private.txt', 'not-exported');
    f.put('mechanism/mutated/cache/private.json', 'not-exported');
    f.put('mechanism/mutated/history.db', 'not-exported');
    f.put('installed-dependencies.bin', 'not-exported');
    exportAcceptanceEvidence({ ...f, kind: 'usage', report: { complete: false } });
    const result = JSON.parse(readFileSync(join(f.directory, 'usage/export.json'), 'utf8'));
    assert.equal(result.files, 3);
    assert.equal(result.report.complete, false);
    assert.equal(
      readFileSync(join(f.directory, 'usage/mechanism/mutated/cases.json'), 'utf8'),
      'semantic-failure',
    );
    assert.throws(() => readFileSync(join(f.directory, 'usage/mechanism/graph/private.txt')));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('wire export retains only reports and does not overwrite retained evidence', () => {
  const f = fixture();
  try {
    f.put('baseline.json', '{}');
    f.put('packages/llm/private.ts', 'not-exported');
    exportAcceptanceEvidence({ ...f, kind: 'wire', report: { complete: true } });
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'wire/export.json'), 'utf8')).files, 1);
    assert.throws(() =>
      exportAcceptanceEvidence({ ...f, kind: 'wire', report: { complete: true } }),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('refuses an export inside authored source', () => {
  const f = fixture();
  try {
    assert.throws(
      () => exportAcceptanceEvidence({ ...f, directory: f.repository, kind: 'wire', report: {} }),
      /outside authored source/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('counts the final manifest within the export byte ceiling', () => {
  const f = fixture();
  try {
    f.put('baseline.json', '');
    truncateSync(join(f.scratch, 'baseline.json'), 256 * 1024 * 1024);
    assert.throws(
      () => exportAcceptanceEvidence({ ...f, kind: 'wire', report: { complete: true } }),
      /including its manifest exceeds its bound/,
    );
    assert.equal(existsSync(join(f.directory, 'wire/export.json')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('refuses an outside lexical path whose existing ancestor resolves into authored source', () => {
  const f = fixture();
  try {
    const link = join(f.root, 'outside-link');
    symlinkSync(f.repository, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () =>
        exportAcceptanceEvidence({
          ...f,
          directory: join(link, 'new/deep'),
          kind: 'wire',
          report: {},
        }),
      /outside authored source/,
    );
    assert.equal(existsSync(join(f.repository, 'new')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
