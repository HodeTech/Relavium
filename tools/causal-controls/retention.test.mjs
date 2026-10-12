import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { digest } from '../usage-coverage-controls/source-graph.mjs';
import { exportMetadata, finish, verifyRetainedEvaluations } from './retention.mjs';
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'causal-retention-'));
  try {
    const repository = join(root, 'repo'),
      scratch = join(root, 'scratch'),
      directory = join(root, 'evidence');
    mkdirSync(repository);
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'summary.json'), '{"complete":false}');
    return fn({
      root,
      repository,
      scratch,
      directory,
      evidenceKind: 'secrets',
      summary: { complete: false },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('exports only bounded own-family metadata, excluding graph/cache/home/native database bytes', () => {
  fixture((options) => {
    for (const dir of ['graph', 'cache', 'home']) {
      mkdirSync(join(options.scratch, dir));
      writeFileSync(join(options.scratch, dir, 'secret.json'), 'excluded');
    }
    writeFileSync(join(options.scratch, 'native.db'), 'excluded');
    writeFileSync(join(options.scratch, 'library.node'), 'excluded');
    exportMetadata(options);
    assert.deepEqual(readdirSync(join(options.directory, 'secrets')).sort(), [
      'export.json',
      'summary.json',
    ]);
    assert.equal(existsSync(join(options.directory, 'filesystem')), false);
    const exported = JSON.parse(
      readFileSync(join(options.directory, 'secrets', 'export.json'), 'utf8'),
    );
    assert.equal(exported.files, 1);
    assert.equal(exported.bytes, readFileSync(join(options.scratch, 'summary.json')).length);
    assert.throws(() => exportMetadata(options), /already exists/);
  });
});
test('native per-PID receipts retain every exact body/dependency byte in bounded archives', () => {
  fixture((options) => {
    const source = join(options.scratch, 'native', 'fixed', 'evaluation');
    mkdirSync(source, { recursive: true });
    const originals = new Map([
      ['12-0.jsonl', '{"pid":12,"threadId":0,"stage":"module-body-entry"}\n'],
      ['12.dependencies.jsonl', '{"pid":12,"stage":"dependency-load-verification"}\n'],
      ['13-0.jsonl', '{"pid":13,"threadId":0,"stage":"module-body-entry"}\n'],
      ['13.dependencies.jsonl', '{"pid":13,"stage":"dependency-load-verification"}\n'],
    ]);
    for (const [name, content] of originals) writeFileSync(join(source, name), content);
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    assert.deepEqual(readdirSync(join(retained, 'native', 'fixed', 'evaluation')).sort(), [
      'dependencies-evaluations.jsonl.gz',
      'source-evaluations.jsonl.gz',
    ]);
    const index = verifyRetainedEvaluations(retained);
    assert.equal(index.segments.length, originals.size);
    for (const segment of index.segments) {
      const name = segment.source.split('/').at(-1);
      const content = originals.get(name);
      assert.ok(content);
      assert.equal(segment.sha256, digest(Buffer.from(content)));
      const raw = gunzipSync(readFileSync(join(retained, segment.retained)));
      assert.equal(
        raw.subarray(segment.offset, segment.offset + segment.bytes).toString('utf8'),
        content,
      );
    }
    const envelope = JSON.parse(readFileSync(join(retained, 'export.json'), 'utf8'));
    assert.equal(envelope.files, 4); // summary + two compressed streams + one exact receipt index
  });
});
test('archive verifier rejects a forged expansion bound before it can decompress unbounded bytes', () => {
  fixture((options) => {
    const source = join(options.scratch, 'native', 'mutated', 'evaluation');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, '12-0.jsonl'),
      '{"pid":12,"threadId":0,"stage":"module-body-entry"}\n',
    );
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    const indexPath = join(retained, 'evaluation-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const compressed = gzipSync(Buffer.alloc(1024));
    const archive = join(retained, index.aggregates[0].retained);
    writeFileSync(archive, compressed);
    index.aggregates[0] = {
      ...index.aggregates[0],
      bytes: 1,
      compressedBytes: compressed.length,
      compressedSha256: digest(compressed),
    };
    writeFileSync(indexPath, JSON.stringify(index));
    assert.throws(() => verifyRetainedEvaluations(retained));
  });
});
for (const [label, mutate] of [
  [
    'index path escape',
    (index) => {
      index.aggregates[0].retained = '../escape/evaluation/source-evaluations.jsonl.gz';
    },
  ],
  [
    'source path escape',
    (index) => {
      index.segments[0].source = '../12-0.jsonl';
    },
  ],
  [
    'segment gap',
    (index) => {
      index.segments[0].offset = 1;
    },
  ],
  [
    'segment length',
    (index) => {
      index.segments[0].bytes -= 1;
    },
  ],
  [
    'segment count',
    (index) => {
      index.segments[0].lines += 1;
    },
  ],
  [
    'receipt count',
    (index) => {
      index.segments = [];
    },
  ],
  [
    'receipt digest',
    (index) => {
      index.segments[0].sha256 = '0'.repeat(64);
    },
  ],
  [
    'raw byte count',
    (index) => {
      index.rawReceiptBytes += 1;
    },
  ],
  [
    'duplicate archive',
    (index) => {
      index.aggregates.push({ ...index.aggregates[0] });
    },
  ],
  [
    'empty archive index',
    (index) => {
      index.aggregates = [];
    },
  ],
  [
    'expansion cap',
    (index) => {
      index.aggregates[0].bytes = 64 * 1024 * 1024 + 1;
    },
  ],
])
  test(`retained receipt verifier rejects ${label}`, () => {
    fixture((options) => {
      const source = join(options.scratch, 'native', 'fixed', 'evaluation');
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, '12-0.jsonl'),
        '{"pid":12,"threadId":0,"stage":"module-body-entry"}\n',
      );
      exportMetadata(options);
      const retained = join(options.directory, 'secrets');
      const indexPath = join(retained, 'evaluation-index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      mutate(index);
      writeFileSync(indexPath, JSON.stringify(index));
      assert.throws(() => verifyRetainedEvaluations(retained));
    });
  });
test('retained receipt verifier rejects a truncated or tampered gzip stream', () => {
  for (const mode of ['truncate', 'tamper'])
    fixture((options) => {
      const source = join(options.scratch, 'native', 'fixed', 'evaluation');
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, '12-0.jsonl'),
        '{"pid":12,"threadId":0,"stage":"module-body-entry"}\n',
      );
      exportMetadata(options);
      const retained = join(options.directory, 'secrets');
      const index = JSON.parse(readFileSync(join(retained, 'evaluation-index.json'), 'utf8'));
      const archive = join(retained, index.aggregates[0].retained);
      const original = readFileSync(archive);
      if (mode === 'truncate') truncateSync(archive, original.length - 1);
      else {
        original[0] ^= 0xff;
        writeFileSync(archive, original);
      }
      assert.throws(() => verifyRetainedEvaluations(retained));
    });
});
test('raw receipt input cap refuses before destination creation', () => {
  fixture((options) => {
    const source = join(options.scratch, 'native', 'fixed', 'evaluation');
    mkdirSync(source, { recursive: true });
    const receipt = join(source, '12-0.jsonl');
    writeFileSync(receipt, '');
    truncateSync(receipt, 64 * 1024 * 1024 + 1);
    assert.throws(() => exportMetadata(options), /Raw evaluation receipt bound/);
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
test('raw receipt file count refuses before index assembly or destination creation', () => {
  fixture((options) => {
    const source = join(options.scratch, 'native', 'fixed', 'evaluation');
    mkdirSync(source, { recursive: true });
    for (let pid = 1; pid <= 2001; pid += 1)
      writeFileSync(
        join(source, `${pid}-0.jsonl`),
        `{"pid":${pid},"threadId":0,"stage":"module-body-entry"}\n`,
      );
    assert.throws(() => exportMetadata(options), /Raw evaluation receipt file bound/);
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
test('overlong receipt path in retained index refuses before decode', () => {
  fixture((options) => {
    const source = join(options.scratch, 'native', 'fixed', 'evaluation');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, '12-0.jsonl'),
      '{"pid":12,"threadId":0,"stage":"module-body-entry"}\n',
    );
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    const indexPath = join(retained, 'evaluation-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.segments[0].source = 'x'.repeat(1025);
    writeFileSync(indexPath, JSON.stringify(index));
    assert.throws(() => verifyRetainedEvaluations(retained), /Evaluation receipt path bound/);
  });
});
test('same repository, same scratch and symlink-redirected export refuse without overwrite', () => {
  fixture((options) => {
    for (const directory of [options.repository, options.scratch])
      assert.throws(() => exportMetadata({ ...options, directory }), /outside/);
    const redirect = join(options.root, 'redirect');
    symlinkSync(options.repository, redirect, 'dir');
    assert.throws(
      () => exportMetadata({ ...options, directory: join(redirect, 'nested') }),
      /outside/,
    );
    assert.throws(() => exportMetadata({ ...options, evidenceKind: '../escape' }), /family/);
  });
});
test('metadata links cannot borrow graph or developer files', () => {
  fixture((options) => {
    symlinkSync(join(options.scratch, 'summary.json'), join(options.scratch, 'linked.json'));
    assert.throws(() => exportMetadata(options), /symlinked/);
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
test('final export metadata counts against byte ceiling before any destination is written', () => {
  fixture((options) => {
    writeFileSync(join(options.scratch, 'large.log'), 'x'.repeat(64 * 1024 * 1024 - 512));
    assert.throws(
      () => exportMetadata({ ...options, summary: { failure: 'x'.repeat(1024) } }),
      /bound/,
    );
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
for (const failure of ['assertion', 'import', 'export'])
  test(`failure cleanup removes scratch and preserves primary ${failure} error when export also fails`, () => {
    fixture((options) => {
      const primaryFailure = new Error(failure);
      const result = finish({ ...options, directory: options.repository, primaryFailure });
      assert.equal(result, primaryFailure);
      assert.equal(existsSync(options.scratch), false);
    });
  });
test('export failure becomes primary and scratch still closes when no earlier failure exists', () => {
  fixture((options) => {
    const error = finish({ ...options, directory: options.repository });
    assert.match(error.message, /outside/);
    assert.equal(existsSync(options.scratch), false);
  });
});
