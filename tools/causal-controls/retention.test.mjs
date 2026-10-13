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
import { runtimeReceiptIdentity, runtimeReporterPath } from './runtime-receipt.mjs';
import {
  decodePhaseStdio,
  encodePhaseStdio,
  exportMetadata,
  finish,
  verifyRetainedEvaluations,
  verifyRetainedSourceManifests,
  verifyRetainedStdio,
  verifyRetainedRuntimeReceipts,
} from './retention.mjs';
function addManifest(scratch, control, phase, content, runtime = true) {
  const directory = join(scratch, control, phase);
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(content);
  writeFileSync(join(directory, 'source-manifest.json'), bytes);
  if (runtime)
    writeFileSync(
      join(directory, 'runtime.json'),
      JSON.stringify({
        phase,
        mutationId: control,
        manifestSha256: digest(bytes),
        infrastructure: [
          { path: join('/physical/graph', runtimeReporterPath), bytes: 1, sha256: 'b'.repeat(64) },
        ],
      }),
    );
  return bytes;
}
const sourceManifest = (space = '') =>
  `{${space}"sourceRoot":"/physical/graph","files":[{"path":"source.ts","bytes":1,"sha256":"${'a'.repeat(64)}"},{"path":"${runtimeReporterPath}","bytes":1,"sha256":"${'b'.repeat(64)}"}]${space}}\n`;
function addPhaseStdio(scratch, control, phase) {
  const directory = join(scratch, control, phase);
  const stdio = encodePhaseStdio('', '');
  writeFileSync(join(directory, 'stdio.bin'), stdio.bytes);
  const identity = runtimeReceiptIdentity(
    readFileSync(join(directory, 'runtime.json')),
    JSON.parse(readFileSync(join(directory, 'source-manifest.json'), 'utf8')),
    123,
  );
  const runnerReceipt =
    JSON.stringify({
      version: 1,
      event: 'onTestRunEnd',
      complete: true,
      ...identity,
      reporter: runtimeReporterPath,
      unhandledErrors: 0,
      reason: phase === 'mutated' ? 'failed' : 'passed',
    }) + '\n';
  writeFileSync(
    join(directory, 'process.json'),
    JSON.stringify({ pid: 123, stdio: stdio.index, runnerReceipt }),
  );
}
function prefixCapture(options, plans, summary) {
  for (const [control, phases] of plans)
    for (const [phase, runtime] of phases) {
      addManifest(options.scratch, control, phase, sourceManifest(), runtime);
      if (runtime) addPhaseStdio(options.scratch, control, phase);
    }
  writeFileSync(join(options.scratch, 'summary.json'), JSON.stringify(summary));
  return { ...options, summary };
}
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
    writeFileSync(join(options.scratch, 'other.bin'), 'excluded');
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
test('a JSON file named source-manifest outside a phase retains ordinary metadata treatment', () => {
  fixture((options) => {
    const other = join(options.scratch, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'source-manifest.json'), '{"note":"ordinary metadata"}\n');
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    assert.equal(
      readFileSync(join(retained, 'other', 'source-manifest.json'), 'utf8'),
      '{"note":"ordinary metadata"}\n',
    );
    assert.equal(existsSync(join(retained, 'source-manifest-index.json')), false);
  });
});
test('phase source manifests retain each exact byte stream with runtime and complete-summary joins', () => {
  fixture((options) => {
    const originals = new Map();
    for (const [phase, whitespace] of [
      ['fixed', ''],
      ['mutated', ' '],
      ['restored', '\n'],
    ])
      originals.set(
        `example-control/${phase}/source-manifest.json`,
        addManifest(options.scratch, 'example-control', phase, sourceManifest(whitespace)),
      );
    for (const phase of ['fixed', 'mutated', 'restored'])
      addPhaseStdio(options.scratch, 'example-control', phase);
    writeFileSync(
      join(options.scratch, 'summary.json'),
      JSON.stringify({ complete: true, mechanisms: [{ id: 'example-control' }] }),
    );
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    const decoded = verifyRetainedSourceManifests(retained);
    assert.equal(decoded.size, 3);
    for (const [source, content] of originals) {
      assert.ok(decoded.get(source).equals(content));
      assert.equal(existsSync(join(retained, source)), false);
    }
    const envelope = JSON.parse(readFileSync(join(retained, 'export.json'), 'utf8'));
    assert.equal(envelope.files, 12); // summary, three runtimes/processes/stdio, archive and index
    assert.deepEqual(
      readdirSync(retained)
        .filter((name) => name.startsWith('source-manifest'))
        .sort(),
      ['source-manifest-index.json', 'source-manifests.json.gz'],
    );
  });
});
test('incomplete pre-runtime phase retains its original manifest without inventing a phase directory', () => {
  fixture((options) => {
    const original = addManifest(
      options.scratch,
      'example-control',
      'fixed',
      sourceManifest(),
      false,
    );
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    assert.equal(existsSync(join(retained, 'example-control', 'fixed')), false);
    assert.ok(
      verifyRetainedSourceManifests(retained)
        .get('example-control/fixed/source-manifest.json')
        .equals(original),
    );
  });
});
test('a completed summary requires physical runtime evidence for each indexed phase', () => {
  fixture((options) => {
    for (const phase of ['fixed', 'mutated', 'restored']) {
      addManifest(options.scratch, 'example-control', phase, sourceManifest());
      addPhaseStdio(options.scratch, 'example-control', phase);
    }
    writeFileSync(
      join(options.scratch, 'summary.json'),
      JSON.stringify({ complete: true, mechanisms: [{ id: 'example-control' }] }),
    );
    exportMetadata(options);
    const root = join(options.directory, 'secrets');
    rmSync(join(root, 'example-control', 'restored', 'runtime.json'));
    assert.throws(() => verifyRetainedSourceManifests(root), /Completed phase/);
  });
});
for (const [label, plans, summary, diagnostic] of [
  [
    'restored-only tail',
    [['pending', [['restored', false]]]],
    { complete: false, mechanisms: [] },
    /Phase manifest prefix/,
  ],
  [
    'fixed/restored gap',
    [
      [
        'pending',
        [
          ['fixed', true],
          ['restored', false],
        ],
      ],
    ],
    { complete: false, mechanisms: [] },
    /Phase manifest prefix/,
  ],
  [
    'two unfinished controls',
    [
      ['first', [['fixed', false]]],
      ['second', [['fixed', false]]],
    ],
    { complete: false, mechanisms: [] },
    /Phase manifest unfinished control/,
  ],
  [
    'missing predecessor runtime',
    [
      [
        'pending',
        [
          ['fixed', false],
          ['mutated', true],
          ['restored', false],
        ],
      ],
    ],
    { complete: false, mechanisms: [] },
    /Phase manifest predecessor runtime/,
  ],
  [
    'unreported tail in complete capture',
    [['pending', [['fixed', true]]]],
    { complete: true, mechanisms: [] },
    /Phase manifest unreported tail/,
  ],
  [
    'duplicate completed mechanism IDs',
    [
      [
        'completed',
        [
          ['fixed', true],
          ['mutated', true],
          ['restored', true],
        ],
      ],
    ],
    { complete: true, mechanisms: [{ id: 'completed' }, { id: 'completed' }] },
    /Phase manifest duplicate completed control/,
  ],
])
  test(`phase manifest prefix verifier rejects ${label}`, () => {
    fixture((options) => {
      const capture = prefixCapture(options, plans, summary);
      assert.throws(() => exportMetadata(capture), diagnostic);
      // Final export validation uses the same standalone verifier; neither may
      // certify the invalid physical subset merely because the bytes are intact.
      assert.throws(
        () => verifyRetainedSourceManifests(join(options.directory, 'secrets')),
        diagnostic,
      );
    });
  });
for (const finalPhase of ['fixed', 'mutated', 'restored'])
  for (const lastRuntime of [false, true])
    test(`phase manifest prefix admits interruption at ${finalPhase} with last runtime ${lastRuntime}`, () => {
      fixture((options) => {
        const names = ['fixed', 'mutated', 'restored'];
        const phases = names
          .slice(0, names.indexOf(finalPhase) + 1)
          .map((phase) => [phase, phase !== finalPhase || lastRuntime]);
        const capture = prefixCapture(options, [['pending', phases]], {
          complete: false,
          mechanisms: [],
        });
        exportMetadata(capture);
        const decoded = verifyRetainedSourceManifests(join(options.directory, 'secrets'));
        assert.deepEqual(
          [...decoded.keys()].sort(),
          phases.map(([phase]) => `pending/${phase}/source-manifest.json`).sort(),
        );
        if (!lastRuntime)
          assert.equal(
            existsSync(join(options.directory, 'secrets', 'pending', finalPhase, 'runtime.json')),
            false,
          );
      });
    });
test('phase manifest prefix admits zero phases and a complete selected control', () => {
  fixture((options) => {
    const capture = prefixCapture(options, [], { complete: false, mechanisms: [] });
    exportMetadata(capture);
    assert.equal(verifyRetainedSourceManifests(join(options.directory, 'secrets')).size, 0);
  });
  fixture((options) => {
    const capture = prefixCapture(
      options,
      [
        [
          'selected',
          [
            ['fixed', true],
            ['mutated', true],
            ['restored', true],
          ],
        ],
      ],
      { complete: false, mechanisms: [{ id: 'selected' }] },
    );
    exportMetadata(capture);
    assert.equal(verifyRetainedSourceManifests(join(options.directory, 'secrets')).size, 3);
  });
});
test('raw phase manifest byte bound refuses before evidence destination creation', () => {
  fixture((options) => {
    const path = join(options.scratch, 'example-control', 'fixed', 'source-manifest.json');
    mkdirSync(join(options.scratch, 'example-control', 'fixed'), { recursive: true });
    writeFileSync(path, 'x');
    truncateSync(path, 64 * 1024 * 1024 + 1);
    assert.throws(() => exportMetadata(options), /Raw phase manifest bound/);
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
test('raw phase manifest file count refuses before archive or destination creation', () => {
  fixture((options) => {
    for (let index = 0; index <= 2000; index++)
      addManifest(options.scratch, `control-${index}`, 'fixed', sourceManifest(), false);
    assert.throws(() => exportMetadata(options), /Raw phase manifest file bound/);
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
for (const mode of [
  'missing-archive',
  'missing-index',
  'missing-both-with-runtime',
  'truncated',
  'archive-digest',
  'raw-length',
  'raw-digest',
  'expansion',
  'escape',
  'backslash',
  'duplicate',
  'gap',
  'overlap',
  'segment-length',
  'runtime-digest',
  'completed-segment',
  'archive-symlink',
  'phase-symlink',
  'overlong-source-path',
  'missing-runtime-segment',
  'extra-raw-byte',
  'second-gzip-member',
])
  test(`phase source manifest verifier rejects ${mode}`, () => {
    fixture((options) => {
      addManifest(options.scratch, 'example-control', 'fixed', sourceManifest());
      exportMetadata(options);
      const root = join(options.directory, 'secrets');
      const archivePath = join(root, 'source-manifests.json.gz');
      const indexPath = join(root, 'source-manifest-index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (mode === 'missing-archive') rmSync(archivePath);
      else if (mode === 'missing-index') rmSync(indexPath);
      else if (mode === 'missing-both-with-runtime') {
        rmSync(archivePath);
        rmSync(indexPath);
      } else if (mode === 'truncated') truncateSync(archivePath, 2);
      else if (mode === 'archive-symlink') {
        rmSync(archivePath);
        symlinkSync(join(options.scratch, 'summary.json'), archivePath);
      } else if (mode === 'phase-symlink') {
        const directory = join(root, 'example-control', 'fixed');
        rmSync(directory, { recursive: true });
        symlinkSync(join(options.scratch, 'example-control', 'fixed'), directory);
      } else {
        if (mode === 'archive-digest') index.archive.compressedSha256 = '0'.repeat(64);
        if (mode === 'raw-length' || mode === 'expansion') {
          index.rawBytes = 1;
          index.archive.bytes = 1;
        }
        if (mode === 'raw-digest') index.archive.sha256 = '0'.repeat(64);
        if (mode === 'escape') index.segments[0].source = '../fixed/source-manifest.json';
        if (mode === 'backslash')
          index.segments[0].source = 'example-control\\fixed\\source-manifest.json';
        if (mode === 'duplicate') index.segments.push({ ...index.segments[0] });
        if (mode === 'overlong-source-path')
          index.segments[0].source = `${'a'.repeat(1025)}/fixed/source-manifest.json`;
        if (mode === 'gap') index.segments[0].offset = 1;
        if (mode === 'overlap')
          index.segments.push({
            ...index.segments[0],
            source: 'second/fixed/source-manifest.json',
          });
        if (mode === 'segment-length') index.segments[0].bytes -= 1;
        if (mode === 'runtime-digest')
          writeFileSync(
            join(root, 'example-control', 'fixed', 'runtime.json'),
            JSON.stringify({ manifestSha256: '0'.repeat(64) }),
          );
        if (mode === 'completed-segment')
          writeFileSync(
            join(root, 'summary.json'),
            JSON.stringify({ complete: true, mechanisms: [{ id: 'example-control' }] }),
          );
        if (mode === 'missing-runtime-segment') index.segments = [];
        if (mode === 'extra-raw-byte') {
          const expanded = Buffer.concat([gunzipSync(readFileSync(archivePath)), Buffer.from('x')]);
          const zipped = gzipSync(expanded);
          writeFileSync(archivePath, zipped);
          index.rawBytes = expanded.length;
          index.archive.bytes = expanded.length;
          index.archive.sha256 = digest(expanded);
          index.archive.compressedBytes = zipped.length;
          index.archive.compressedSha256 = digest(zipped);
        }
        if (mode === 'second-gzip-member') {
          const zipped = Buffer.concat([readFileSync(archivePath), gzipSync(Buffer.alloc(0))]);
          writeFileSync(archivePath, zipped);
          index.archive.compressedBytes = zipped.length;
          index.archive.compressedSha256 = digest(zipped);
        }
        writeFileSync(indexPath, JSON.stringify(index));
      }
      assert.throws(() => verifyRetainedSourceManifests(root));
    });
  });
test('retains exact bounded stdout and stderr in one independently verifiable phase envelope', () => {
  fixture((options) => {
    const phase = join(options.scratch, 'example-control', 'fixed');
    mkdirSync(phase, { recursive: true });
    const stdout = 'first\nλ\n',
      stderr = 'refusal\n';
    const stdio = encodePhaseStdio(stdout, stderr);
    writeFileSync(join(phase, 'stdio.bin'), stdio.bytes);
    writeFileSync(
      join(phase, 'process.json'),
      JSON.stringify({ joined: true, stdio: stdio.index }),
    );
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    const records = verifyRetainedStdio(retained);
    assert.deepEqual(records, [{ control: 'example-control', phase: 'fixed', stdout, stderr }]);
    assert.deepEqual(readdirSync(join(retained, 'example-control', 'fixed')).sort(), [
      'process.json',
      'stdio.bin',
    ]);
    assert.deepEqual(decodePhaseStdio(stdio.bytes, stdio.index), { stdout, stderr });
    const envelope = JSON.parse(readFileSync(join(retained, 'export.json'), 'utf8'));
    assert.equal(envelope.files, 3); // summary, process, and exact combined stdio
  });
});
for (const mode of [
  'truncate',
  'length',
  'digest',
  'missing-pair',
  'redirect',
  'encoding',
  'overlong',
])
  test(`retained stdio verifier refuses ${mode}`, () => {
    fixture((options) => {
      const phase = join(options.scratch, 'example-control', 'fixed');
      mkdirSync(phase, { recursive: true });
      const stdio = encodePhaseStdio('valid', 'diagnostic');
      writeFileSync(join(phase, 'stdio.bin'), stdio.bytes);
      writeFileSync(join(phase, 'process.json'), JSON.stringify({ stdio: stdio.index }));
      exportMetadata(options);
      const retained = join(options.directory, 'secrets', 'example-control', 'fixed');
      const path = join(retained, 'stdio.bin');
      if (mode === 'truncate') truncateSync(path, stdio.bytes.length - 1);
      else if (mode === 'length') {
        const bytes = readFileSync(path);
        bytes.writeUInt32BE(1, 0);
        writeFileSync(path, bytes);
      } else if (mode === 'digest') {
        const processPath = join(retained, 'process.json');
        const report = JSON.parse(readFileSync(processPath, 'utf8'));
        report.stdio.stdout.sha256 = '0'.repeat(64);
        writeFileSync(processPath, JSON.stringify(report));
      } else if (mode === 'missing-pair') rmSync(path);
      else if (mode === 'redirect') {
        rmSync(path);
        symlinkSync(join(options.scratch, 'summary.json'), path);
      } else if (mode === 'overlong') {
        truncateSync(path, 8 + 3 * 8 * 1024 * 1024 + 1);
      } else {
        const processPath = join(retained, 'process.json');
        const report = JSON.parse(readFileSync(processPath, 'utf8'));
        const bytes = readFileSync(path);
        bytes[8] = 0xff;
        report.stdio.stdout.sha256 = digest(bytes.subarray(8, 13));
        writeFileSync(path, bytes);
        writeFileSync(processPath, JSON.stringify(report));
      }
      assert.throws(() => verifyRetainedStdio(join(options.directory, 'secrets')));
    });
  });
test('standalone stdio verifier requires every completed mechanism phase', () => {
  fixture((options) => {
    const phase = join(options.scratch, 'example-control', 'fixed');
    mkdirSync(phase, { recursive: true });
    const stdio = encodePhaseStdio('out', 'err');
    writeFileSync(join(phase, 'stdio.bin'), stdio.bytes);
    writeFileSync(join(phase, 'process.json'), JSON.stringify({ stdio: stdio.index }));
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    writeFileSync(
      join(retained, 'summary.json'),
      JSON.stringify({ complete: false, mechanisms: [{ id: 'example-control' }] }),
    );
    assert.throws(() => verifyRetainedStdio(retained), /Completed phase stdio missing/);
  });
});
test('stdio encoder and decoder enforce the unchanged process-output authority', () => {
  assert.throws(
    () => encodePhaseStdio('x'.repeat(8 * 1024 * 1024 + 1), ''),
    /Process output bound/,
  );
  const stdio = encodePhaseStdio('', '');
  const widened = { ...stdio.index, stdout: { ...stdio.index.stdout, bytes: 1 } };
  assert.throws(() => decodePhaseStdio(stdio.bytes, widened), /length differs/);
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
    for (let pid = 1; pid <= 4097; pid += 1)
      writeFileSync(
        join(source, `${pid}-0.jsonl`),
        `{"pid":${pid},"threadId":0,"stage":"module-body-entry"}\n`,
      );
    assert.throws(() => exportMetadata(options), /Raw evaluation receipt file bound/);
    assert.equal(existsSync(join(options.directory, 'secrets')), false);
  });
});
test('4096 synthetic PID/thread journals retain every source and dependency receipt', () => {
  fixture((options) => {
    const source = join(options.scratch, 'native', 'fixed', 'evaluation');
    mkdirSync(source, { recursive: true });
    const originals = new Map();
    for (let index = 0; index < 4096; index += 1) {
      const pid = Math.floor(index / 3) + 1;
      const kind = index % 3;
      const name =
        kind === 1
          ? `${pid}.dependencies.jsonl`
          : `${pid}-${kind === 2 ? 1 : 0}${kind === 2 ? '.loader-preparation' : ''}.jsonl`;
      const record =
        kind === 1
          ? { pid, stage: 'dependency-load-verification' }
          : {
              pid,
              threadId: kind === 2 ? 1 : 0,
              stage: kind === 2 ? 'loader-helper-body-entry' : 'module-body-entry',
            };
      const content = Buffer.from(`${JSON.stringify(record)}\n`);
      originals.set(name, content);
      writeFileSync(join(source, name), content);
    }
    exportMetadata(options);
    const retained = join(options.directory, 'secrets');
    const index = verifyRetainedEvaluations(retained);
    assert.equal(index.segments.length, originals.size);
    const decoded = new Map(
      index.aggregates.map((aggregate) => [
        aggregate.retained,
        gunzipSync(readFileSync(join(retained, aggregate.retained))),
      ]),
    );
    for (const segment of index.segments) {
      const original = originals.get(segment.source.split('/').at(-1));
      const raw = decoded.get(segment.retained);
      assert.ok(original && raw);
      assert.equal(segment.sha256, digest(original));
      assert.deepEqual(raw.subarray(segment.offset, segment.offset + segment.bytes), original);
    }
    assert.equal(JSON.parse(readFileSync(join(retained, 'export.json'), 'utf8')).files, 4);
    const indexPath = join(retained, 'evaluation-index.json');
    index.segments.push(index.segments[0]);
    writeFileSync(indexPath, JSON.stringify(index));
    assert.throws(() => verifyRetainedEvaluations(retained), /Evaluation index count bound/);
  });
});
for (const files of [1998, 1999])
  test(`physical retained file ceiling includes summary and envelope: ${files} data files`, () => {
    fixture((options) => {
      for (let index = 0; index < files; index += 1)
        writeFileSync(join(options.scratch, `${index}.json`), '{}');
      const destination = join(options.directory, 'secrets');
      if (files === 1999) {
        assert.throws(() => exportMetadata(options), /Metadata export bound/);
        assert.equal(existsSync(destination), false);
      } else {
        exportMetadata(options);
        assert.equal(readdirSync(destination).length, 2000);
        assert.equal(
          JSON.parse(readFileSync(join(destination, 'export.json'), 'utf8')).files,
          1999,
        );
      }
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

for (const phase of ['fixed', 'mutated', 'restored'])
  for (const defect of [
    'missing',
    'malformed',
    'incomplete',
    'errors',
    'wrong-phase',
    'wrong-runtime',
    'wrong-source',
    'wrong-process',
    'wrong-reason',
    'runtime-phase',
    'reporter-unowned',
    'read-failure',
  ])
    test(`retained acceptance refuses ${defect} runtime receipt at ${phase}`, () => {
      fixture((options) => {
        const capture = prefixCapture(
          options,
          [
            [
              'accepted',
              [
                ['fixed', true],
                ['mutated', true],
                ['restored', true],
              ],
            ],
          ],
          { complete: true, mechanisms: [{ id: 'accepted' }] },
        );
        exportMetadata(capture);
        const root = join(options.directory, 'secrets');
        assert.equal(verifyRetainedRuntimeReceipts(root).length, 3);
        const processPath = join(root, 'accepted', phase, 'process.json');
        const report = JSON.parse(readFileSync(processPath, 'utf8'));
        const receipt = JSON.parse(report.runnerReceipt);
        if (defect === 'incomplete') receipt.complete = false;
        if (defect === 'errors') receipt.unhandledErrors = 1;
        if (defect === 'wrong-phase') receipt.phase = 'other';
        if (defect === 'wrong-runtime') receipt.runtimeSha256 = 'c'.repeat(64);
        if (defect === 'wrong-source') receipt.reporterSha256 = 'c'.repeat(64);
        if (defect === 'wrong-process') receipt.pid = 321;
        if (defect === 'wrong-reason') receipt.reason = 'interrupted';
        report.runnerReceipt = `${JSON.stringify(receipt)}\n`;
        if (defect === 'missing') delete report.runnerReceipt;
        if (defect === 'malformed') report.runnerReceipt = '{';
        if (defect === 'read-failure') report.runnerReceiptFailure = { message: 'read failed' };
        if (defect === 'runtime-phase' || defect === 'reporter-unowned') {
          const runtimePath = join(root, 'accepted', phase, 'runtime.json');
          const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
          if (defect === 'runtime-phase') runtime.phase = 'other';
          else runtime.infrastructure = [];
          const raw = JSON.stringify(runtime);
          writeFileSync(runtimePath, raw);
          receipt.runtimeSha256 = digest(raw);
          report.runnerReceipt = `${JSON.stringify(receipt)}\n`;
        }
        writeFileSync(processPath, JSON.stringify(report));
        assert.throws(
          () => verifyRetainedRuntimeReceipts(root),
          /receipt|runtime|reporter|completion|JSON|property/i,
        );
      });
    });
