/** Bounded metadata-only evidence with primary-failure-preserving cleanup. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { digest, json } from '../usage-coverage-controls/source-graph.mjs';
import { maxProcessOutputUnits } from './process.mjs';
const maxFiles = 2000,
  maxBytes = 64 * 1024 * 1024,
  maxReceiptPathBytes = 1024;
// UTF-8 takes at most three bytes per UTF-16 code unit. The process cap remains
// exactly 8,388,608 decoded code units.
const maxStdioBytes = 8 + 3 * maxProcessOutputUnits;
const receiptName = /^(\d+)(?:-(\d+))?(?:\.(loader-preparation|dependencies))?\.jsonl$/;

/** One byte-exact, independently bounded envelope replaces two per-phase log files. */
export function encodePhaseStdio(stdout, stderr) {
  assert.ok(
    typeof stdout === 'string' &&
      typeof stderr === 'string' &&
      stdout.length + stderr.length <= maxProcessOutputUnits,
    'Process output bound',
  );
  const out = Buffer.from(stdout, 'utf8'),
    err = Buffer.from(stderr, 'utf8');
  assert.ok(out.length + err.length + 8 <= maxStdioBytes, 'Stdio envelope bound');
  const bytes = Buffer.allocUnsafe(8 + out.length + err.length);
  bytes.writeUInt32BE(out.length, 0);
  bytes.writeUInt32BE(err.length, 4);
  out.copy(bytes, 8);
  err.copy(bytes, 8 + out.length);
  return {
    bytes,
    index: {
      version: 1,
      stdout: { bytes: out.length, sha256: digest(out) },
      stderr: { bytes: err.length, sha256: digest(err) },
    },
  };
}

/** Reconstruct both original log byte streams and refuse malformed or expanded envelopes. */
export function decodePhaseStdio(bytes, index) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.length <= maxStdioBytes);
  assert.equal(index?.version, 1);
  for (const stream of ['stdout', 'stderr']) {
    assert.ok(Number.isSafeInteger(index[stream]?.bytes) && index[stream].bytes >= 0);
    assert.match(index[stream]?.sha256, /^[a-f0-9]{64}$/);
  }
  const outLength = bytes.readUInt32BE(0),
    errLength = bytes.readUInt32BE(4);
  assert.equal(outLength, index.stdout.bytes, 'Stdio stdout length differs');
  assert.equal(errLength, index.stderr.bytes, 'Stdio stderr length differs');
  assert.equal(bytes.length, 8 + outLength + errLength, 'Stdio envelope length differs');
  const out = bytes.subarray(8, 8 + outLength),
    err = bytes.subarray(8 + outLength);
  assert.equal(digest(out), index.stdout.sha256, 'Stdio stdout digest differs');
  assert.equal(digest(err), index.stderr.sha256, 'Stdio stderr digest differs');
  const stdout = out.toString('utf8'),
    stderr = err.toString('utf8');
  assert.ok(
    stdout.length + stderr.length <= maxProcessOutputUnits &&
      Buffer.from(stdout, 'utf8').equals(out) &&
      Buffer.from(stderr, 'utf8').equals(err),
    'Stdio decoded process bound',
  );
  return { stdout, stderr };
}

function* boundedDirectoryEntries(path) {
  const directory = opendirSync(path);
  let count = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      assert.ok(++count <= maxFiles, 'Retained stdio directory bound');
      yield entry;
    }
  } finally {
    directory.closeSync();
  }
}

/** Standalone verifier for all retained phase stdout/stderr bytes. */
export function verifyRetainedStdio(destination) {
  const root = realpathSync(destination);
  const reconstructed = [];
  let retainedFiles = 0,
    retainedBytes = 0;
  function countRetained(path, bound) {
    const info = lstatSync(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path);
    assert.ok(info.size <= bound, 'Retained stdio input bound');
    retainedFiles++;
    retainedBytes += info.size;
    assert.ok(retainedFiles <= maxFiles && retainedBytes <= maxBytes, 'Retained stdio total bound');
  }
  for (const control of boundedDirectoryEntries(root)) {
    assert.ok(!control.isSymbolicLink(), 'Retained control path redirected');
    if (!control.isDirectory()) continue;
    const controlPath = join(root, control.name);
    for (const phase of boundedDirectoryEntries(controlPath)) {
      if (!['fixed', 'mutated', 'restored'].includes(phase.name)) continue;
      assert.ok(phase.isDirectory() && !phase.isSymbolicLink(), 'Retained phase path redirected');
      const phasePath = join(controlPath, phase.name);
      const names = new Set([...boundedDirectoryEntries(phasePath)].map((entry) => entry.name));
      const hasProcess = names.has('process.json'),
        hasStdio = names.has('stdio.bin');
      assert.equal(hasProcess, hasStdio, 'Retained process/stdio pair incomplete');
      if (!hasProcess) continue; // A failed pre-spawn phase has neither completed artifact.
      const processPath = join(phasePath, 'process.json'),
        stdioPath = join(phasePath, 'stdio.bin');
      countRetained(processPath, maxStdioBytes);
      countRetained(stdioPath, maxStdioBytes);
      const report = JSON.parse(readFileSync(processPath, 'utf8'));
      const streams = decodePhaseStdio(readFileSync(stdioPath), report.stdio);
      reconstructed.push({ control: control.name, phase: phase.name, ...streams });
    }
  }
  const summaryPath = join(root, 'summary.json');
  countRetained(summaryPath, maxBytes);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  if (summary.mechanisms !== undefined) {
    assert.ok(Array.isArray(summary.mechanisms) && summary.mechanisms.length <= maxFiles);
    const phases = new Set(reconstructed.map(({ control, phase }) => `${control}/${phase}`));
    for (const mechanism of summary.mechanisms) {
      assert.ok(typeof mechanism.id === 'string' && mechanism.id.length <= 1024);
      for (const phase of ['fixed', 'mutated', 'restored'])
        assert.ok(phases.has(`${mechanism.id}/${phase}`), 'Completed phase stdio missing');
    }
  }
  return reconstructed;
}
function receiptIdentity(name, kind) {
  const match = receiptName.exec(name);
  assert.ok(match, 'Unknown evaluation receipt');
  const [, pid, thread, suffix] = match;
  assert.ok(
    kind === 'dependencies'
      ? suffix === 'dependencies' && thread === undefined
      : (suffix === undefined || suffix === 'loader-preparation') && thread !== undefined,
    'Evaluation receipt filename/kind disagreement',
  );
  const numericPid = Number(pid),
    numericThread = thread === undefined ? undefined : Number(thread);
  assert.ok(Number.isSafeInteger(numericPid) && numericPid > 0, 'Invalid receipt PID');
  assert.ok(
    numericThread === undefined || (Number.isSafeInteger(numericThread) && numericThread >= 0),
    'Invalid receipt thread',
  );
  return { pid: numericPid, thread: numericThread, suffix };
}

export function exportMetadata({ directory, scratch, repository, evidenceKind, summary }) {
  assert.ok(['filesystem', 'secrets'].includes(evidenceKind), 'Unknown evidence family');
  if (directory === undefined) return;
  let ancestor = resolve(directory);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const base = resolve(realpathSync(ancestor), relative(ancestor, resolve(directory)));
  const destination = join(base, evidenceKind);
  for (const root of [repository, scratch]) {
    const delta = relative(realpathSync(root), destination);
    assert.ok(
      delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta),
      'Evidence must be outside repository and scratch',
    );
  }
  assert.ok(!existsSync(destination), 'Evidence destination already exists');
  const entries = [];
  let bytes = 0;
  let rawReceiptBytes = 0;
  let rawReceiptFiles = 0;
  let indexBytes = 1024; // fixed JSON keys, punctuation and counters
  const aggregates = [];
  const segments = [];
  function indexEntry(entry) {
    indexBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    assert.ok(indexBytes <= maxBytes, 'Evaluation index bound');
  }
  function add(path, content) {
    entries.push({ path, content });
    bytes += content.length;
    assert.ok(entries.length + 1 <= maxFiles && bytes <= maxBytes, 'Metadata export bound');
  }
  function collectEvaluations(dir, rel) {
    const groups = new Map([
      ['source', []],
      ['dependencies', []],
    ]);
    const handle = opendirSync(dir);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        const source = join(dir, entry.name);
        assert.ok(
          !lstatSync(source).isSymbolicLink() && entry.isFile(),
          'Evaluation receipt must be physical',
        );
        const kind = entry.name.endsWith('.dependencies.jsonl') ? 'dependencies' : 'source';
        receiptIdentity(entry.name, kind);
        assert.ok(++rawReceiptFiles <= maxFiles, 'Raw evaluation receipt file bound');
        const size = lstatSync(source).size;
        assert.ok(size <= maxBytes - rawReceiptBytes, 'Raw evaluation receipt bound');
        const content = readFileSync(source);
        assert.equal(content.length, size, 'Evaluation receipt changed during export');
        assert.ok(content.length > 0 && content.at(-1) === 10, 'Incomplete evaluation receipt');
        rawReceiptBytes += content.length;
        groups.get(kind).push({ name: entry.name, content });
      }
    } finally {
      handle.closeSync();
    }
    for (const [kind, files] of groups) {
      if (files.length === 0) continue;
      files.sort((a, b) => a.name.localeCompare(b.name));
      let offset = 0;
      const retained = join(rel, `${kind}-evaluations.jsonl.gz`);
      for (const file of files) {
        const segment = {
          source: join(rel, file.name),
          retained,
          offset,
          bytes: file.content.length,
          sha256: digest(file.content),
          lines: file.content.toString('utf8').split('\n').length - 1,
        };
        assert.ok(
          Buffer.byteLength(segment.source) <= maxReceiptPathBytes &&
            Buffer.byteLength(segment.retained) <= maxReceiptPathBytes,
          'Evaluation receipt path bound',
        );
        indexEntry(segment);
        segments.push(segment);
        offset += file.content.length;
      }
      const raw = Buffer.concat(
        files.map((file) => file.content),
        offset,
      );
      const compressed = gzipSync(raw, { level: 9, mtime: 0 });
      const aggregate = {
        retained,
        bytes: raw.length,
        sha256: digest(raw),
        compressedBytes: compressed.length,
        compressedSha256: digest(compressed),
      };
      indexEntry(aggregate);
      aggregates.push(aggregate);
      add(retained, compressed);
    }
  }
  function collect(dir, rel = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['graph', 'cache', 'home'].includes(entry.name)) continue;
      const source = join(dir, entry.name),
        path = join(rel, entry.name);
      assert.ok(!lstatSync(source).isSymbolicLink(), 'Metadata must not be symlinked');
      if (
        entry.isDirectory() &&
        entry.name === 'evaluation' &&
        /(?:^|[/\\])(?:fixed|mutated|restored)$/.test(rel)
      )
        collectEvaluations(source, path);
      else if (entry.isDirectory()) collect(source, path);
      else if (
        entry.isFile() &&
        (/\.(json|jsonl|log)$/.test(entry.name) ||
          (entry.name === 'stdio.bin' && /(?:^|[/\\])(?:fixed|mutated|restored)$/.test(rel)))
      ) {
        const size = lstatSync(source).size;
        assert.ok(size <= maxBytes - bytes, 'Metadata export bound');
        const content = readFileSync(source);
        assert.equal(content.length, size, 'Metadata changed during export');
        add(path, content);
      }
    }
  }
  collect(scratch);
  if (aggregates.length > 0)
    add(
      'evaluation-index.json',
      Buffer.from(`${JSON.stringify({ version: 1, rawReceiptBytes, aggregates, segments })}\n`),
    );
  const metadata = Buffer.from(
    JSON.stringify({ version: 1, files: entries.length, bytes, report: summary }, null, 2) + '\n',
  );
  assert.ok(bytes + metadata.length <= maxBytes, 'Metadata export bound');
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  for (const entry of entries) {
    mkdirSync(dirname(join(destination, entry.path)), { recursive: true });
    writeFileSync(join(destination, entry.path), entry.content, { flag: 'wx' });
  }
  writeFileSync(join(destination, 'export.json'), metadata, { flag: 'wx' });
  if (aggregates.length > 0) verifyRetainedEvaluations(destination);
  verifyRetainedStdio(destination);
}
/** Verify every original per-PID receipt without unbounded gzip expansion. */
export function verifyRetainedEvaluations(destination) {
  const root = realpathSync(destination);
  const indexPath = join(root, 'evaluation-index.json');
  const indexInfo = lstatSync(indexPath);
  assert.ok(indexInfo.isFile() && !indexInfo.isSymbolicLink() && indexInfo.size <= maxBytes);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(index.version, 1);
  assert.ok(Array.isArray(index.aggregates) && Array.isArray(index.segments));
  assert.ok(
    index.aggregates.length > 0 &&
      index.aggregates.length <= maxFiles &&
      index.segments.length > 0 &&
      index.segments.length <= maxFiles,
    'Evaluation index count bound',
  );
  assert.ok(
    Number.isSafeInteger(index.rawReceiptBytes) &&
      index.rawReceiptBytes > 0 &&
      index.rawReceiptBytes <= maxBytes,
  );
  let rawTotal = 0;
  let retainedReceiptBytes = indexInfo.size;
  const decoded = new Map();
  for (const aggregate of index.aggregates) {
    assert.ok(
      Number.isSafeInteger(aggregate.bytes) && aggregate.bytes > 0 && aggregate.bytes <= maxBytes,
      'Invalid evaluation expansion bound',
    );
    assert.ok(
      typeof aggregate.retained === 'string' &&
        Buffer.byteLength(aggregate.retained) <= maxReceiptPathBytes,
      'Evaluation archive path bound',
    );
    assert.match(
      aggregate.retained,
      /(?:^|[/\\])evaluation[/\\](?:source|dependencies)-evaluations\.jsonl\.gz$/,
    );
    const path = resolve(root, aggregate.retained);
    const delta = relative(root, path);
    assert.ok(
      delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta),
      'Evaluation path escape',
    );
    const info = lstatSync(path);
    assert.ok(
      info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path,
      'Evaluation archive redirected',
    );
    assert.ok(rawTotal + aggregate.bytes <= maxBytes, 'Raw evaluation receipt bound');
    assert.equal(info.size, aggregate.compressedBytes);
    assert.ok(info.size <= maxBytes, 'Evaluation archive bound');
    retainedReceiptBytes += info.size;
    assert.ok(retainedReceiptBytes <= maxBytes, 'Retained evaluation receipt bound');
    const compressed = readFileSync(path);
    assert.equal(digest(compressed), aggregate.compressedSha256);
    const raw = gunzipSync(compressed, { maxOutputLength: aggregate.bytes });
    assert.equal(raw.length, aggregate.bytes);
    assert.equal(digest(raw), aggregate.sha256);
    assert.ok(!decoded.has(aggregate.retained), 'Duplicate evaluation archive');
    decoded.set(aggregate.retained, raw);
    rawTotal += raw.length;
  }
  let segmentTotal = 0;
  const seen = new Set();
  const cursor = new Map([...decoded.keys()].map((path) => [path, 0]));
  for (const segment of index.segments) {
    assert.ok(
      typeof segment.source === 'string' &&
        typeof segment.retained === 'string' &&
        Buffer.byteLength(segment.source) <= maxReceiptPathBytes &&
        Buffer.byteLength(segment.retained) <= maxReceiptPathBytes,
      'Evaluation receipt path bound',
    );
    assert.ok(!seen.has(segment.source), 'Duplicate evaluation receipt');
    seen.add(segment.source);
    assert.equal(
      dirname(segment.source),
      dirname(segment.retained),
      'Evaluation source path mismatch',
    );
    const kind =
      segment.retained.endsWith('/dependencies-evaluations.jsonl.gz') ||
      segment.retained.endsWith('\\dependencies-evaluations.jsonl.gz')
        ? 'dependencies'
        : 'source';
    const name = segment.source.split(/[/\\]/).at(-1);
    const identity = receiptIdentity(name, kind);
    const raw = decoded.get(segment.retained);
    assert.ok(raw, 'Evaluation archive missing');
    assert.ok(
      Number.isSafeInteger(segment.offset) &&
        segment.offset >= 0 &&
        Number.isSafeInteger(segment.bytes) &&
        segment.bytes > 0 &&
        segment.offset + segment.bytes <= raw.length,
      'Evaluation receipt offset outside archive',
    );
    assert.equal(segment.offset, cursor.get(segment.retained), 'Evaluation receipt gap/overlap');
    assert.equal(
      digest(raw.subarray(segment.offset, segment.offset + segment.bytes)),
      segment.sha256,
    );
    const original = raw.subarray(segment.offset, segment.offset + segment.bytes);
    assert.equal(original.at(-1), 10, 'Incomplete evaluation receipt');
    const lines = original.toString('utf8').split('\n').slice(0, -1);
    assert.equal(lines.length, segment.lines, 'Evaluation receipt line count differs');
    for (const line of lines) {
      const record = JSON.parse(line);
      assert.equal(record.pid, identity.pid, 'Evaluation receipt PID differs');
      if (kind === 'dependencies') assert.equal(record.stage, 'dependency-load-verification');
      else {
        assert.equal(record.threadId, identity.thread, 'Evaluation receipt thread differs');
        assert.equal(
          record.stage,
          identity.suffix === 'loader-preparation'
            ? 'loader-helper-body-entry'
            : 'module-body-entry',
        );
      }
    }
    cursor.set(segment.retained, segment.offset + segment.bytes);
    segmentTotal += segment.bytes;
  }
  for (const [path, bytes] of cursor) assert.equal(bytes, decoded.get(path).length);
  assert.equal(segmentTotal, rawTotal);
  assert.equal(segmentTotal, index.rawReceiptBytes);
  return index;
}
export function finish({ scratch, summary, primaryFailure, directory, repository, evidenceKind }) {
  try {
    json(join(scratch, 'summary.json'), summary);
  } catch (error) {
    primaryFailure ??= error;
  }
  try {
    exportMetadata({ scratch, summary, directory, repository, evidenceKind });
  } catch (error) {
    primaryFailure ??= error;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    primaryFailure ??= error;
  }
  return primaryFailure;
}
